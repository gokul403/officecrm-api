import type { AIProvider } from "./types.js";
import { AzureOpenAIProvider } from "./providers/azure-openai.js";
import { GeminiProvider } from "./providers/gemini.js";

let cached: AIProvider | null = null;

export function createAIProvider(): AIProvider {
  const providerName = (process.env.AI_PROVIDER ?? "gemini").toLowerCase().trim();

  switch (providerName) {
    case "gemini":
      return new GeminiProvider();
    case "azure":
    case "azure-openai":
      return new AzureOpenAIProvider();
    default:
      throw new Error(
        `Unsupported AI_PROVIDER="${providerName}". Supported: gemini, azure. Add a new provider under src/ai/providers/.`
      );
  }
}

/** Lazy singleton for request handlers */
export function getAIProvider(): AIProvider {
  if (!cached) {
    cached = createAIProvider();
  }
  return cached;
}

export type { AIProvider, ChatInput, ChatResult, ToolDef, ToolCall, ChatMessage } from "./types.js";
