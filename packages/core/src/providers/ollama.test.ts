import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderUnavailableError } from "../types.ts";
import type { ModelRequest } from "../types.ts";
import { createOllamaProvider } from "./ollama.ts";

type Captured = { url: string; body: any };

function fakeFetch(respond: (c: Captured) => Response | Promise<Response>, seen: Captured[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const c = { url: String(url), body: JSON.parse(String(init.body)) };
    seen.push(c);
    return respond(c);
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const request: ModelRequest = {
  system: "You are the Floor manager.",
  messages: [
    { role: "user", text: "Kevin: add a task" },
    { role: "assistant", text: "On it.", toolCalls: [{ id: "c1", name: "board_add", input: { title: "Do it" } }] },
    { role: "tool", results: [{ id: "c1", name: "board_add", output: "Added T-4.", isError: false }, { id: "c2", name: "board_edit", output: "No item", isError: true }] },
  ],
  tools: [{ name: "board_add", description: "Add", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }],
  maxOutputTokens: 700,
};

test("sends the native chat request: system first, tools, options, tool results", async () => {
  const seen: Captured[] = [];
  const p = createOllamaProvider({
    model: "gemma4:e4b",
    numCtx: 8192,
    think: false,
    keepAlive: "30m",
    fetch: fakeFetch(() => json({ message: { content: "ok" }, done_reason: "stop" }), seen),
  });
  await p.complete(request);
  const { url, body } = seen[0]!;
  assert.equal(url, "http://127.0.0.1:11434/api/chat");
  assert.equal(body.model, "gemma4:e4b");
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, "30m");
  assert.deepEqual(body.options, { num_ctx: 8192, num_predict: 700 });
  assert.deepEqual(body.messages[0], { role: "system", content: "You are the Floor manager." });
  assert.deepEqual(body.messages[1], { role: "user", content: "Kevin: add a task" });
  assert.deepEqual(body.messages[2], {
    role: "assistant",
    content: "On it.",
    tool_calls: [{ function: { name: "board_add", arguments: { title: "Do it" } } }],
  });
  assert.deepEqual(body.messages[3], { role: "tool", tool_name: "board_add", content: "Added T-4." });
  assert.deepEqual(body.messages[4], { role: "tool", tool_name: "board_edit", content: "Error: No item" });
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "board_add");
  assert.deepEqual(body.tools[0].function.parameters.required, ["title"]);
});

test("optional settings are left out when not given; no tools means no tools key", async () => {
  const seen: Captured[] = [];
  const p = createOllamaProvider({ model: "m", baseUrl: "http://pi.local:11434/", fetch: fakeFetch(() => json({ message: { content: "hi" } }), seen) });
  await p.complete({ system: "", messages: [{ role: "user", text: "hello" }], tools: [] });
  const { url, body } = seen[0]!;
  assert.equal(url, "http://pi.local:11434/api/chat");
  assert.ok(!("think" in body) && !("keep_alive" in body) && !("tools" in body));
  assert.deepEqual(body.options, { num_ctx: 16384 });
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
});

test("reads text, tool calls (object or string arguments), ids and token counts", async () => {
  const p = createOllamaProvider({
    model: "m",
    fetch: fakeFetch(() =>
      json({
        message: {
          content: "Checking.",
          thinking: "ignored",
          tool_calls: [
            { id: "call_x", function: { name: "get_weather", arguments: { city: "Denver" } } },
            { function: { name: "board_list", arguments: '{"board":"pi.md"}' } },
            { function: { name: "broken", arguments: "{ not json" } },
            { function: { arguments: {} } },
          ],
        },
        done_reason: "stop",
        prompt_eval_count: 70,
        eval_count: 175,
      }),
    ),
  });
  const r = await p.complete(request);
  assert.equal(r.text, "Checking.");
  assert.deepEqual(r.toolCalls, [
    { id: "call_x", name: "get_weather", input: { city: "Denver" } },
    { id: "call_1", name: "board_list", input: { board: "pi.md" } },
    { id: "call_2", name: "broken", input: {} },
  ]);
  assert.deepEqual(r.usage, { inputTokens: 70, outputTokens: 175 });
  assert.equal(r.stopReason, "stop");
});

test("Ollama not running becomes a readable, fixable error", async () => {
  const p = createOllamaProvider({ model: "m", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
  await assert.rejects(
    () => p.complete(request),
    (e: unknown) => e instanceof ProviderUnavailableError && /Can't reach Ollama at http:\/\/127\.0\.0\.1:11434/.test(e.message) && /ollama serve/.test(e.hint),
  );
});

test("a model that is not pulled says how to pull it", async () => {
  const p = createOllamaProvider({ model: "gemma4:26b", fetch: fakeFetch(() => json({ error: "model 'gemma4:26b' not found" }, 404)) });
  await assert.rejects(
    () => p.complete(request),
    (e: unknown) => e instanceof ProviderUnavailableError && /gemma4:26b/.test(e.message) && e.hint === "Run: ollama pull gemma4:26b",
  );
});

test("a model without tool support and other failures are told apart", async () => {
  const noTools = createOllamaProvider({ model: "tiny", fetch: fakeFetch(() => json({ error: "registry.ollama.ai/library/tiny does not support tools" }, 400)) });
  await assert.rejects(() => noTools.complete(request), (e: unknown) => e instanceof ProviderUnavailableError && /cannot call tools/.test(e.message));
  const boom = createOllamaProvider({ model: "m", fetch: fakeFetch(() => json({ error: "out of memory" }, 500)) });
  await assert.rejects(() => boom.complete(request), (e: unknown) => !(e instanceof ProviderUnavailableError) && /500: out of memory/.test((e as Error).message));
});

test("a timeout is reported as slow, not as unreachable", async () => {
  // AbortSignal.timeout does not keep the process alive, so hold the event loop open while we wait for it.
  const hold = setTimeout(() => undefined, 2000);
  const p = createOllamaProvider({
    model: "m",
    timeoutMs: 20,
    fetch: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch,
  });
  try {
    await assert.rejects(() => p.complete(request), (e: unknown) => e instanceof ProviderUnavailableError && /did not answer within/.test(e.message));
  } finally {
    clearTimeout(hold);
  }
});
