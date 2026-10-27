// Core types for the provider seam. Nothing here depends on any model SDK.

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ToolResult = { id: string; name: string; output: string; isError?: boolean };

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export type ToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  run(input: Record<string, unknown>): Promise<string> | string;
};

export type ToolSpec = Pick<Tool, "name" | "description" | "inputSchema">;

export type Usage = { inputTokens: number; outputTokens: number };

export type ModelRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
};

export type ModelResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason?: string;
};

/** The seam. Every model backend (Bedrock, Anthropic key, Ollama, fake) implements this. */
export interface Provider {
  readonly id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** Thrown by providers when credentials are missing or expired, so the UI can show a useful message. */
export class ProviderAuthError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "ProviderAuthError";
    this.hint = hint;
  }
}
