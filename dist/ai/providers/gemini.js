import { GoogleGenerativeAI, SchemaType, } from "@google/generative-ai";
function mapProperty(prop) {
    if (prop.enum?.length) {
        return {
            type: SchemaType.STRING,
            description: prop.description,
            format: "enum",
            enum: prop.enum,
        };
    }
    switch (prop.type) {
        case "number":
        case "integer":
            return { type: SchemaType.NUMBER, description: prop.description };
        case "boolean":
            return { type: SchemaType.BOOLEAN, description: prop.description };
        case "array":
            return {
                type: SchemaType.ARRAY,
                description: prop.description,
                items: prop.items ? mapProperty(prop.items) : { type: SchemaType.STRING },
            };
        case "object":
            return {
                type: SchemaType.OBJECT,
                description: prop.description,
                properties: {},
            };
        default:
            return { type: SchemaType.STRING, description: prop.description };
    }
}
function toolDefsToGemini(tools) {
    const functionDeclarations = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
            type: SchemaType.OBJECT,
            properties: Object.fromEntries(Object.entries(tool.parameters.properties).map(([key, prop]) => [key, mapProperty(prop)])),
            required: tool.parameters.required,
        },
    }));
    return { functionDeclarations };
}
function toGeminiContents(messages) {
    const contents = [];
    for (const msg of messages) {
        if (msg.role === "system")
            continue;
        if (msg.role === "user") {
            contents.push({ role: "user", parts: [{ text: msg.content }] });
            continue;
        }
        if (msg.role === "assistant") {
            // Prefer exact model parts so thoughtSignature / thought parts survive tool rounds.
            if (msg.providerModelParts?.length) {
                contents.push({
                    role: "model",
                    parts: msg.providerModelParts,
                });
                continue;
            }
            const parts = [];
            if (msg.content)
                parts.push({ text: msg.content });
            if (msg.toolCalls?.length) {
                for (const call of msg.toolCalls) {
                    // Gemini 3 / flash-latest require thoughtSignature on functionCall parts
                    // when replaying the model turn after tools run.
                    const part = {
                        functionCall: {
                            name: call.name,
                            args: call.arguments,
                        },
                        ...(call.thoughtSignature
                            ? { thoughtSignature: call.thoughtSignature }
                            : {}),
                    };
                    parts.push(part);
                }
            }
            if (parts.length === 0)
                parts.push({ text: "" });
            contents.push({ role: "model", parts });
            continue;
        }
        if (msg.role === "tool") {
            contents.push({
                role: "user",
                parts: [
                    {
                        functionResponse: {
                            name: msg.name ?? "tool",
                            response: { result: msg.content },
                        },
                    },
                ],
            });
        }
    }
    return contents;
}
export class GeminiProvider {
    name = "gemini";
    client;
    chatModel;
    embeddingModel;
    embeddingDimensions;
    constructor(options) {
        const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY ?? "";
        if (!apiKey) {
            throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini");
        }
        this.client = new GoogleGenerativeAI(apiKey);
        this.chatModel = options?.chatModel ?? process.env.GEMINI_CHAT_MODEL ?? "gemini-2.0-flash";
        this.embeddingModel =
            options?.embeddingModel ?? process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
        this.embeddingDimensions =
            options?.embeddingDimensions ??
                Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 768);
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const model = this.client.getGenerativeModel({ model: this.embeddingModel });
        const vectors = [];
        const dims = this.embeddingDimensions;
        // Batch one-by-one to stay within free-tier request size limits.
        // @google/generative-ai does not expose outputDimensionality; truncate MRL prefix + L2-normalize
        // (required for gemini-embedding-001 when not using full 3072 dims).
        for (const text of texts) {
            const result = await model.embedContent({
                content: { role: "user", parts: [{ text }] },
                // Pass through for SDKs/APIs that forward unknown fields; ignored if unsupported.
                ...(dims
                    ? { outputDimensionality: dims }
                    : {}),
            });
            const values = result.embedding?.values;
            if (!values?.length) {
                throw new Error("Gemini embedContent returned empty embedding");
            }
            vectors.push(truncateAndNormalize(Array.from(values), dims));
        }
        return vectors;
    }
    async chat(input) {
        const tools = input.tools?.length ? [toolDefsToGemini(input.tools)] : undefined;
        const model = this.client.getGenerativeModel({
            model: this.chatModel,
            systemInstruction: input.system,
            tools,
        });
        const contents = toGeminiContents(input.messages);
        const result = await model.generateContent({ contents });
        const response = result.response;
        const candidate = response.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        const toolCalls = [];
        const textParts = [];
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part.functionCall) {
                const thoughtSignature = readThoughtSignature(part);
                toolCalls.push({
                    id: `call_${part.functionCall.name}_${i}`,
                    name: part.functionCall.name,
                    arguments: (part.functionCall.args ?? {}),
                    ...(thoughtSignature ? { thoughtSignature } : {}),
                });
            }
            else if (typeof part.text === "string") {
                textParts.push(part.text);
            }
        }
        return {
            content: textParts.length ? textParts.join("") : null,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            providerModelParts: parts.length ? parts : undefined,
        };
    }
}
/** Read thought signature from a Part (SDK types omit this field). */
function readThoughtSignature(part) {
    const raw = part;
    const value = raw.thoughtSignature ?? raw.thought_signature;
    if (typeof value === "string" && value.length > 0)
        return value;
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString("base64");
    }
    return undefined;
}
/** Keep MRL prefix and L2-normalize for cosine similarity at reduced dims. */
function truncateAndNormalize(values, dims) {
    const truncated = values.length > dims ? values.slice(0, dims) : values;
    if (truncated.length !== dims) {
        throw new Error(`Gemini embedding length ${truncated.length} does not match expected ${dims} dimensions`);
    }
    let sumSquares = 0;
    for (const v of truncated)
        sumSquares += v * v;
    const norm = Math.sqrt(sumSquares);
    if (!norm || !Number.isFinite(norm))
        return truncated;
    return truncated.map((v) => v / norm);
}
