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

test("for notes questions a specialist lists, then reads, before answering", async () => {
  const tools = ["files_list", "files_read", "suggest_next"].map((name) => ({ name, description: "d", inputSchema: { type: "object" as const, properties: {} } }));
  const base = { system: 'Your id is "synthesizer".', tools };
  const first = await demo.complete({ ...base, messages: [{ role: "user", text: "pull themes from my interview notes" }] });
  assert.deepEqual(first.toolCalls.map((c) => [c.name, c.input]), [["files_list", { folder: "Interviews" }]]);
  const listed = [
    { role: "user" as const, text: "pull themes from my interview notes" },
    { role: "assistant" as const, text: "", toolCalls: first.toolCalls },
    { role: "tool" as const, results: [{ id: first.toolCalls[0]!.id, name: "files_list", output: "Interviews/a.md (1 KB)\nInterviews/b.md (1 KB)" }] },
  ];
  const second = await demo.complete({ ...base, messages: listed });
  assert.deepEqual(second.toolCalls.map((c) => [c.name, c.input]), [["files_read", { path: "Interviews/a.md" }]]);
  const read = [...listed, { role: "assistant" as const, text: "", toolCalls: second.toolCalls }, { role: "tool" as const, results: [{ id: second.toolCalls[0]!.id, name: "files_read", output: "text" }] }];
  const last = await demo.complete({ ...base, messages: read });
  assert.deepEqual(last.toolCalls.map((c) => c.name), ["suggest_next"]);
  assert.match(last.text, /Theme 1/);
  // An empty folder skips the read, and other messages skip the lookups.
  const empty = [listed[0]!, listed[1]!, { role: "tool" as const, results: [{ id: first.toolCalls[0]!.id, name: "files_list", output: "No readable files found." }] }];
  assert.deepEqual((await demo.complete({ ...base, messages: empty })).toolCalls.map((c) => c.name), ["suggest_next"]);
  assert.deepEqual((await demo.complete({ ...base, messages: [{ role: "user", text: "hello" }] })).toolCalls.map((c) => c.name), ["suggest_next"]);
});

test("the demo's suggestions come with a ready-to-send message for the teammate", async () => {
  const tools = [{ name: "suggest_next", description: "d", inputSchema: { type: "object" as const, properties: {} } }];
  const from = async (id: string) => {
    const res = await demo.complete({ system: `Your id is "${id}".`, messages: [{ role: "user", text: "hello" }], tools });
    return res.toolCalls[0]!.input as { agent_id: string; message: string };
  };
  const fromResearch = await from("research-lead");
  assert.equal(fromResearch.agent_id, "synthesizer");
  assert.match(fromResearch.message, /themes/);
  const fromSynth = await from("synthesizer");
  assert.equal(fromSynth.agent_id, "research-lead");
  assert.match(fromSynth.message, /next round of interviews/);
});
