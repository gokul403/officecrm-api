export type ChatRole = "user" | "assistant" | "tool" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** Present when role is tool — name of the tool that produced this result */
  name?: string;
  /** Present on assistant messages that requested tools */
  toolCalls?: ToolCall[];
  /** Links a tool result to the call id */
  toolCallId?: string;
  /**
   * Opaque provider parts from the model turn (e.g. Gemini thoughtSignature).
   * When set, replayed as-is instead of rebuilding from toolCalls.
   */
  providerModelParts?: unknown[];
};

export type ToolParameterProperty = {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty;
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Gemini thinking models attach this to functionCall parts.
   * Must be echoed back on the next turn or generateContent returns 400.
   */
  thoughtSignature?: string;
};

export type ChatInput = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  system?: string;
};

export type ChatResult = {
  content: string | null;
  toolCalls?: ToolCall[];
  /** Raw model parts to echo on the next turn (Gemini thought signatures, etc.) */
  providerModelParts?: unknown[];
};

export interface AIProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
  chat(input: ChatInput): Promise<ChatResult>;
}
