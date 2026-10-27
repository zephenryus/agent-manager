import type { ModelRequest, ModelResponse, Provider } from "../types.ts";

export type FakeProvider = Provider & { readonly requests: ModelRequest[] };

/** Deterministic provider for tests and offline spikes. Returns the scripted responses in order. */
export function createFakeProvider(script: ModelResponse[]): FakeProvider {
  const queue = [...script];
  const requests: ModelRequest[] = [];
  return {
    id: "fake",
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const next = queue.shift();
      if (!next) throw new Error("Fake provider script exhausted");
      return next;
    },
  };
}

export function reply(text: string, tokens = { inputTokens: 10, outputTokens: 5 }): ModelResponse {
  return { text, toolCalls: [], usage: tokens, stopReason: "end_turn" };
}

export function callTool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  text = "",
  tokens = { inputTokens: 10, outputTokens: 5 },
): ModelResponse {
  return { text, toolCalls: [{ id, name, input }], usage: tokens, stopReason: "tool_use" };
}
