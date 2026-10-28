// Ollama provider for local models (for example gemma4). Plain fetch against Ollama's native /api/chat, no
// dependencies. The native API (not the OpenAI-compatible one) returns tool arguments as objects and exact
// token counts. One call here is one model step; the core turn loop runs the tools.
import { ProviderUnavailableError } from "../types.ts";
import type { Message, ModelRequest, ModelResponse, Provider } from "../types.ts";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export type OllamaOptions = {
  /** Model tag, for example "gemma4:e4b". */
  model: string;
  baseUrl?: string;
  /**
   * Context window in tokens. Ollama's own default is small, and a prompt longer than the window is silently
   * cut off at the start (the charter!), so set this above what an agent turn sends.
   */
  numCtx?: number;
  /** Turn the model's "thinking" on or off. Left out, the model decides (Gemma 4 thinks by default). */
  think?: boolean;
  /** How long Ollama keeps the model in memory after a call, for example "30m". */
  keepAlive?: string;
  /** Local models can be slow. Default 10 minutes per call. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
};

export const DEFAULT_NUM_CTX = 16_384;

type OllamaToolCall = { id?: string; function?: { name?: string; arguments?: unknown } };
type OllamaChatResponse = {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

export function createOllamaProvider(opts: OllamaOptions): Provider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  return {
    id: `ollama:${opts.model}`,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const body = {
        model: opts.model,
        stream: false,
        messages: toOllamaMessages(req),
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
        options: {
          num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
          ...(req.maxOutputTokens !== undefined ? { num_predict: req.maxOutputTokens } : {}),
        },
        ...(opts.think !== undefined ? { think: opts.think } : {}),
        ...(opts.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
      };

      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw translateNetworkError(err, baseUrl, timeoutMs);
      }

      if (!res.ok) throw await translateHttpError(res, opts.model);

      const data = (await res.json()) as OllamaChatResponse;
      let text = data.message?.content ?? "";
      let toolCalls = (data.message?.tool_calls ?? [])
        .map((c, i) => ({
          id: c.id ?? `call_${i}`,
          name: c.function?.name ?? "",
          input: parseArguments(c.function?.arguments),
        }))
        .filter((c) => c.name !== "");
      if (toolCalls.length === 0) {
        // Sometimes the model writes its call as text in its own syntax and Ollama does not convert it.
        const salvaged = salvageTextToolCalls(text, req.tools.map((t) => t.name));
        if (salvaged.calls.length > 0) {
          text = salvaged.text;
          toolCalls = salvaged.calls;
        }
      }
      return {
        text,
        toolCalls,
        usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
        ...(data.done_reason !== undefined ? { stopReason: data.done_reason } : {}),
      };
    },
  };
}

const GEMMA_QUOTE = '<|"|>';

/**
 * Recovers tool calls a model wrote as plain text, in Gemma's own syntax:
 *   suggest_next{agent_id:<|"|>research-lead<|"|>,reason:<|"|>Why.<|"|>}
 * Only names of tools this request offered are accepted, and a call that does not parse cleanly is left in
 * the text. The recovered calls are removed from the text so the reply reads normally.
 */
export function salvageTextToolCalls(
  text: string,
  names: string[],
): { text: string; calls: { id: string; name: string; input: Record<string, unknown> }[] } {
  const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const hit = names
      .map((name) => ({ name, at: findCall(text, name, i) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (!hit) break;
    const open = hit.at + hit.name.length; // index of "{"
    const parsed = parseNativeArgs(text, open + 1);
    if (!parsed) {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += text.slice(i, hit.at).replace(/(?:<\|?tool_call\|?>\s*)?(?:call:)?$/, "");
    calls.push({ id: `call_${calls.length}`, name: hit.name, input: parsed.args });
    i = parsed.end;
    const tail = /^\s*(?:<\|?tool_call\|?>)?/.exec(text.slice(i));
    if (tail) i += tail[0].length;
  }
  out += text.slice(i);
  return calls.length > 0 ? { text: out.trim(), calls } : { text, calls };
}

/** Index of `name{` in text at or after `from`, where `name` is not the tail of a longer word. */
function findCall(text: string, name: string, from: number): number {
  let at = text.indexOf(`${name}{`, from);
  while (at > 0 && /[\w]/.test(text[at - 1]!)) at = text.indexOf(`${name}{`, at + 1);
  return at;
}

function parseNativeArgs(text: string, start: number): { args: Record<string, unknown>; end: number } | null {
  const args: Record<string, unknown> = {};
  let pos = start;
  for (;;) {
    while (pos < text.length && /[\s,]/.test(text[pos]!)) pos++;
    if (text[pos] === "}") return { args, end: pos + 1 };
    const key = /^[A-Za-z_][\w-]*/.exec(text.slice(pos));
    if (!key || text[pos + key[0].length] !== ":") return null;
    pos += key[0].length + 1;
    if (text.startsWith(GEMMA_QUOTE, pos)) {
      const close = text.indexOf(GEMMA_QUOTE, pos + GEMMA_QUOTE.length);
      if (close < 0) return null;
      args[key[0]] = text.slice(pos + GEMMA_QUOTE.length, close);
      pos = close + GEMMA_QUOTE.length;
    } else if (text[pos] === '"') {
      let end = pos + 1;
      while (end < text.length && (text[end] !== '"' || text[end - 1] === "\\")) end++;
      if (end >= text.length) return null;
      try {
        args[key[0]] = JSON.parse(text.slice(pos, end + 1));
      } catch {
        return null;
      }
      pos = end + 1;
    } else {
      const bare = /^[^,}]*/.exec(text.slice(pos))![0].trim();
      if (bare === "") return null;
      args[key[0]] = bare === "true" ? true : bare === "false" ? false : /^-?\d+(\.\d+)?$/.test(bare) ? Number(bare) : bare;
      pos += /^[^,}]*/.exec(text.slice(pos))![0].length;
    }
  }
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function toOllamaMessages(req: ModelRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system.trim() !== "") out.push({ role: "system", content: req.system });
  for (const m of req.messages as Message[]) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text,
        ...(m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) }
          : {}),
      });
    } else {
      // Ollama has no error flag on tool results, so say it in the text.
      for (const r of m.results) {
        out.push({ role: "tool", tool_name: r.name, content: r.isError ? `Error: ${r.output}` : r.output });
      }
    }
  }
  return out;
}

function translateNetworkError(err: unknown, baseUrl: string, timeoutMs: number): unknown {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ProviderUnavailableError(
      `Ollama did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      "A big model can be slow on a first load. Try a smaller model, or raise the timeout.",
    );
  }
  return new ProviderUnavailableError(
    `Can't reach Ollama at ${baseUrl}.`,
    "Start Ollama (on Windows it runs from the system tray, or run `ollama serve`), and check the address in your config.",
  );
}

async function translateHttpError(res: Response, model: string): Promise<unknown> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = body.error;
  } catch {
    // body was not JSON
  }
  if (res.status === 404 || /not found/i.test(detail)) {
    return new ProviderUnavailableError(`Ollama does not have the model "${model}".`, `Run: ollama pull ${model}`);
  }
  if (/does not support tools/i.test(detail)) {
    return new ProviderUnavailableError(`The model "${model}" cannot call tools.`, "Pick a model that supports tools, such as gemma4.");
  }
  return new Error(`Ollama returned ${res.status}${detail ? `: ${detail}` : ""}`);
}
