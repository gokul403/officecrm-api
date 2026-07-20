import OpenAI from "openai";
import { GeminiProvider } from "./gemini.js";
function mapProperty(prop) {
    if (prop.enum?.length) {
        return {
            type: "string",
            description: prop.description,
            enum: prop.enum,
        };
    }
    switch (prop.type) {
        case "number":
            return { type: "number", description: prop.description };
        case "integer":
            return { type: "integer", description: prop.description };
        case "boolean":
            return { type: "boolean", description: prop.description };
        case "array":
            return {
                type: "array",
                description: prop.description,
                items: prop.items ? mapProperty(prop.items) : { type: "string" },
            };
        case "object":
            return {
                type: "object",
                description: prop.description,
                properties: {},
            };
        default:
            return { type: "string", description: prop.description };
    }
}
function toolDefsToOpenAI(tools) {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: {
                type: "object",
                properties: Object.fromEntries(Object.entries(tool.parameters.properties).map(([key, prop]) => [
                    key,
                    mapProperty(prop),
                ])),
                required: tool.parameters.required,
            },
        },
    }));
}
function toOpenAIMessages(messages, system) {
    const out = [];
    if (system?.trim()) {
        out.push({ role: "system", content: system });
    }
    for (const msg of messages) {
        if (msg.role === "system")
            continue;
        if (msg.role === "user") {
            out.push({ role: "user", content: msg.content });
            continue;
        }
        if (msg.role === "assistant") {
            if (msg.toolCalls?.length) {
                out.push({
                    role: "assistant",
                    content: msg.content || null,
                    tool_calls: msg.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: {
                            name: call.name,
                            arguments: JSON.stringify(call.arguments ?? {}),
                        },
                    })),
                });
            }
            else {
                out.push({ role: "assistant", content: msg.content });
            }
            continue;
        }
        if (msg.role === "tool") {
            out.push({
                role: "tool",
                tool_call_id: msg.toolCallId ?? `call_${msg.name ?? "tool"}`,
                content: msg.content,
            });
        }
    }
    return out;
}
function parseToolArguments(raw) {
    if (!raw?.trim())
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
        return {};
    }
}
/**
 * Azure OpenAI for chat/tool-calling; Gemini for embeddings (keeps vector(768) RAG intact).
 */
export class AzureOpenAIProvider {
    name = "azure-openai";
    client;
    chatDeployment;
    embedProvider;
    constructor(options) {
        const endpoint = (options?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? "")
            .trim()
            .replace(/\/$/, "");
        const apiKey = options?.apiKey ?? process.env.AZURE_OPENAI_API_KEY ?? "";
        const apiVersion = options?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
        this.chatDeployment =
            options?.chatDeployment ?? process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "";
        if (!endpoint) {
            throw new Error("AZURE_OPENAI_ENDPOINT is required when AI_PROVIDER=azure");
        }
        if (!apiKey) {
            throw new Error("AZURE_OPENAI_API_KEY is required when AI_PROVIDER=azure");
        }
        if (!this.chatDeployment) {
            throw new Error("AZURE_OPENAI_CHAT_DEPLOYMENT is required when AI_PROVIDER=azure");
        }
        // Deployment-scoped base URL — model/deployment is part of the path for Azure.
        this.client = new OpenAI({
            apiKey,
            baseURL: `${endpoint}/openai/deployments/${this.chatDeployment}`,
            defaultQuery: { "api-version": apiVersion },
            defaultHeaders: { "api-key": apiKey },
        });
        this.embedProvider = options?.embedProvider ?? new GeminiProvider();
    }
    async embed(texts) {
        return this.embedProvider.embed(texts);
    }
    async chat(input) {
        const tools = input.tools?.length ? toolDefsToOpenAI(input.tools) : undefined;
        const messages = toOpenAIMessages(input.messages, input.system);
        const completion = await this.client.chat.completions.create({
            // Azure ignores this when using deployment-scoped baseURL, but the SDK requires it.
            model: this.chatDeployment,
            messages,
            ...(tools?.length ? { tools } : {}),
        });
        const choice = completion.choices[0]?.message;
        if (!choice) {
            return { content: null };
        }
        const toolCalls = [];
        if (choice.tool_calls?.length) {
            for (const call of choice.tool_calls) {
                if (call.type !== "function")
                    continue;
                toolCalls.push({
                    id: call.id,
                    name: call.function.name,
                    arguments: parseToolArguments(call.function.arguments),
                });
            }
        }
        const content = typeof choice.content === "string" && choice.content.length
            ? choice.content
            : null;
        return {
            content,
            toolCalls: toolCalls.length ? toolCalls : undefined,
        };
    }
}
