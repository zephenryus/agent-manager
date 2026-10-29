import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SUGGESTION_MESSAGE, createSuggestTool } from "./roomTools.ts";
import type { Suggestion } from "./transcript.ts";

function setup() {
  const sink: Suggestion[] = [];
  const tool = createSuggestTool("research-lead", ["research-lead", "synthesizer"], sink);
  const run = async (input: Record<string, unknown>): Promise<string> => tool.run(input);
  return { sink, run };
}

test("a suggestion carries the ready-to-send message, trimmed", async () => {
  const { sink, run } = setup();
  await run({ agent_id: "synthesizer", reason: "themes", message: "  Can you pull themes from the notes?  " });
  assert.deepEqual(sink, [{ agentId: "synthesizer", reason: "themes", message: "Can you pull themes from the notes?" }]);
});

test("the message is optional: a missing or blank one leaves it off", async () => {
  const a = setup();
  await a.run({ agent_id: "synthesizer", reason: "themes" });
  assert.deepEqual(a.sink, [{ agentId: "synthesizer", reason: "themes" }]);
  const b = setup();
  await b.run({ agent_id: "synthesizer", reason: "themes", message: "   " });
  assert.deepEqual(b.sink, [{ agentId: "synthesizer", reason: "themes" }]);
});

test("a message that is not text or is too long is refused with a clear reason", async () => {
  const { sink, run } = setup();
  await assert.rejects(() => run({ agent_id: "synthesizer", reason: "r", message: 42 }), /message must be text/);
  await assert.rejects(() => run({ agent_id: "synthesizer", reason: "r", message: "x".repeat(MAX_SUGGESTION_MESSAGE + 1) }), /too long.*call suggest_next again/);
  assert.deepEqual(sink, []);
  await run({ agent_id: "synthesizer", reason: "r", message: "x".repeat(MAX_SUGGESTION_MESSAGE) });
  assert.equal(sink.length, 1);
});

test("the existing rules still hold: no self-suggestions, unknown ids, one chip per teammate", async () => {
  const { sink, run } = setup();
  await assert.rejects(() => run({ agent_id: "research-lead", reason: "r" }), /cannot suggest yourself/);
  await assert.rejects(() => run({ agent_id: "nobody", reason: "r" }), /Unknown teammate/);
  await run({ agent_id: "synthesizer", reason: "first", message: "one" });
  await run({ agent_id: "synthesizer", reason: "second", message: "two" });
  assert.deepEqual(sink, [{ agentId: "synthesizer", reason: "first", message: "one" }]);
});
