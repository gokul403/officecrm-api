import { AzureOpenAIProvider } from "./providers/azure-openai.js";
import { GeminiProvider } from "./providers/gemini.js";
let cached = null;
export function createAIProvider() {
    const providerName = (process.env.AI_PROVIDER ?? "gemini").toLowerCase().trim();
    switch (providerName) {
        case "gemini":
            return new GeminiProvider();
        case "azure":
        case "azure-openai":
            return new AzureOpenAIProvider();
        default:
            throw new Error(`Unsupported AI_PROVIDER="${providerName}". Supported: gemini, azure. Add a new provider under src/ai/providers/.`);
    }
}
/** Lazy singleton for request handlers */
export function getAIProvider() {
    if (!cached) {
        cached = createAIProvider();
    }
    return cached;
}
