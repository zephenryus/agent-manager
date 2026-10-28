import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoProvider } from "./demo.ts";
import type { ModelRequest } from "../types.ts";

const demo = createDemoProvider({ delayMs: 0 });

const routeReq = (text: string): ModelRequest => ({
  system: "router",
  messages: [{ role: "user", text: `Recent messages:\nuser: hi\n\nNew message from the user:\n${text}` }],
  tools: [{ name: "route", description: "d", inputSchema: { type: "object", properties: {} } }],
});

test("routes by keyword using only the new message", async () => {
  const pick = async (text: string) => {
    const res = await demo.complete(routeReq(text));
    return (res.toolCalls[0]!.input as { responders: string[] }).responders[0];
  };
  assert.equal(await pick("Here are my interview notes"), "synthesizer");
  assert.equal(await pick("Help me plan some research"), "research-lead");
  assert.equal(await pick("What is on the board?"), "floor-manager");
});

test("an agent reply uses the id in its system prompt and may suggest a teammate", async () => {
  const tools = [{ name: "suggest_next", description: "d", inputSchema: { type: "object" as const, properties: {} } }];
  const res = await demo.complete({
    system: 'You are Research lead. Your id is "research-lead".',
    messages: [{ role: "user", text: "hello" }],
    tools,
  });
  assert.match(res.text, /clarifying question/);
  assert.equal(res.toolCalls[0]?.name, "suggest_next");
  assert.ok(res.usage.inputTokens > 0 && res.usage.outputTokens > 0);
});

test("the floor manager does not suggest anyone", async () => {
  const res = await demo.complete({
    system: 'Your id is "floor-manager".',
    messages: [{ role: "user", text: "status?" }],
    tools: [{ name: "suggest_next", description: "d", inputSchema: { type: "object", properties: {} } }],
  });
  assert.deepEqual(res.toolCalls, []);
});
