import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgents } from "./agents.ts";
import type { AgentDef } from "./agents.ts";
import { callTool, createFakeProvider, reply } from "./providers/fake.ts";
import { KNOWN_TOOLS, createRoom } from "./room.ts";
import type { RoomEvent } from "./room.ts";
import { createLlmRouter } from "./router.ts";
import { readTail } from "./transcript.ts";
import type { Clock } from "./transcript.ts";
import type { ModelResponse } from "./types.ts";
import { openVault } from "./vault.ts";

const SAMPLE_AGENTS = fileURLToPath(new URL("../../../sample-vault/agents", import.meta.url));

async function setup(opts: { routerScript?: ModelResponse[]; specialistScript?: ModelResponse[]; agents?: AgentDef[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "am-room-"));
  const vault = openVault(root);
  const agents = opts.agents ?? (await loadAgents(SAMPLE_AGENTS, [...KNOWN_TOOLS])).agents;
  const routerProvider = createFakeProvider(opts.routerScript ?? []);
  const specialist = createFakeProvider(opts.specialistScript ?? []);
  const events: RoomEvent[] = [];
  let n = 0;
  const clock: Clock = { now: () => new Date(Date.UTC(2026, 9, 27, 20, 0, n)), newId: () => `id-${n++}` };
  const room = createRoom({
    vault,
    agents,
    providers: { router: routerProvider, specialist },
    router: createLlmRouter({ provider: routerProvider, agents, orchestratorId: "floor-manager" }),
    userName: "Kevin",
    clock,
    onEvent: (e) => events.push(e),
  });
  return { root, vault, room, routerProvider, specialist, events, agents };
}

const route = (responders: string[], extra: Record<string, unknown> = {}) =>
  callTool("rt", "route", { responders, reason: "test", ...extra });

test("a routed message produces a reply, a transcript, notes and the right events", async () => {
  const { vault, room, specialist, events } = await setup({
    routerScript: [route(["research-lead"])],
    specialistScript: [
      callTool("n1", "notes_append", { text: "Kevin wants interviews first" }, "Noting that."),
      reply("Start with five interviews."),
    ],
  });

  const result = await room.send("How should we start discovery?");

  assert.equal(result.decision?.source, "llm");
  assert.deepEqual(result.replies.map((r) => [r.from, r.text]), [
    ["research-lead", "Noting that.\n\nStart with five interviews."],
  ]);
  // router 10/5 + two specialist steps 10/5 each
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 15 });
  assert.deepEqual(result.replies[0]!.usage, { inputTokens: 20, outputTokens: 10 });

  const transcript = await readTail(vault.roomFile, 10);
  assert.deepEqual(transcript.map((t) => t.from), ["user", "research-lead"]);

  const log = await readFile(vault.notes("research-lead").log, "utf8");
  assert.match(log, /Kevin wants interviews first/);

  assert.deepEqual(
    events.map((e) => (e.type === "agent_state" ? `state:${e.state}` : e.type === "turn" ? `turn:${e.event.type}` : e.type)),
    [
      "entry", // the user's message
      "routing",
      "state:thinking",
      "turn:text",
      "turn:tool_call",
      "state:working",
      "turn:tool_result",
      "turn:text",
      "entry", // the reply
      "state:idle",
    ],
  );

  // The agent saw its charter, the user's message and exactly its listed tools.
  const req = specialist.requests[0]!;
  assert.match(req.system, /You lead customer discovery/);
  assert.deepEqual(req.messages.map((m) => m.role), ["user"]);
  assert.deepEqual(req.tools.map((t) => t.name).sort(), ["notes_append", "notes_head", "notes_pin", "notes_tail", "suggest_next"]);
});

test("an @mention skips the router entirely", async () => {
  const { room, routerProvider } = await setup({ specialistScript: [reply("Three themes.")] });
  const result = await room.send("@synthesizer what themes do you see?");
  assert.equal(result.decision?.source, "mention");
  assert.deepEqual(result.replies.map((r) => r.from), ["synthesizer"]);
  assert.equal(routerProvider.requests.length, 0);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test("a direct message goes to one agent, in its own private transcript", async () => {
  const { vault, room, routerProvider, specialist } = await setup({ specialistScript: [reply("Happy to help.")] });
  const result = await room.send("Can you help me privately?", { dm: "synthesizer" });
  assert.equal(result.decision, null);
  assert.equal(routerProvider.requests.length, 0);
  assert.match(specialist.requests[0]!.system, /private chat with Kevin/);
  assert.equal((await readTail(vault.dmFile("synthesizer"), 10)).length, 2);
  assert.equal((await readTail(vault.roomFile, 10)).length, 0);
});

test("a second responder sees the first responder's reply", async () => {
  const { room, specialist } = await setup({
    routerScript: [route(["research-lead", "synthesizer"])],
    specialistScript: [reply("Plan: interview five people."), reply("I will tag themes as notes arrive.")],
  });
  const result = await room.send("Plan discovery and tell me how you will synthesize it.");
  assert.deepEqual(result.replies.map((r) => r.from), ["research-lead", "synthesizer"]);
  const lastMessage = specialist.requests[1]!.messages.at(-1)!;
  assert.equal(lastMessage.role, "user");
  assert.match(lastMessage.role === "user" ? lastMessage.text : "", /\[Research lead\]: Plan: interview five people\./);
});

test("suggestions from the router and from agents are merged without duplicates or repliers", async () => {
  const { room } = await setup({
    routerScript: [
      route(["research-lead"], {
        suggestions: [
          { agent_id: "synthesizer", reason: "router thinks so" },
          { agent_id: "research-lead", reason: "already answering" },
        ],
      }),
    ],
    specialistScript: [
      callTool("s1", "suggest_next", { agent_id: "floor-manager", reason: "check priorities" }),
      callTool("s2", "suggest_next", { agent_id: "synthesizer", reason: "agent also thinks so" }),
      reply("Done."),
    ],
  });
  const result = await room.send("Plan discovery");
  assert.deepEqual(result.suggestions, [
    { agentId: "synthesizer", reason: "router thinks so" },
    { agentId: "floor-manager", reason: "check priorities" },
  ]);
  assert.deepEqual(result.replies[0]!.suggestions, [
    { agentId: "floor-manager", reason: "check priorities" },
    { agentId: "synthesizer", reason: "agent also thinks so" },
  ]);
});

test("an answer written alongside suggest_next is the whole reply, with no extra model call", async () => {
  const { room, vault, specialist } = await setup({
    specialistScript: [
      callTool("s1", "suggest_next", { agent_id: "research-lead", reason: "needs follow-ups" }, "Theme 1: trust. Theme 2: rework."),
      reply("I've suggested the Research lead."), // must never be requested
    ],
  });
  const result = await room.send("@synthesizer here are the notes");
  assert.equal(result.replies[0]!.text, "Theme 1: trust. Theme 2: rework.");
  assert.equal(specialist.requests.length, 1);
  assert.deepEqual(result.suggestions, [{ agentId: "research-lead", reason: "needs follow-ups" }]);
  // Two model calls would have cost twice the prompt: one call's usage only.
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
  const [, stored] = await readTail(vault.roomFile, 2);
  assert.equal(stored!.text, "Theme 1: trust. Theme 2: rework.");
});

test("suggest_next with no answer text still gets a follow-up call so the agent can answer", async () => {
  const { room, specialist } = await setup({
    specialistScript: [
      callTool("s1", "suggest_next", { agent_id: "research-lead", reason: "r" }), // no text
      reply("Here is my actual answer."),
    ],
  });
  const result = await room.send("@synthesizer hello");
  assert.equal(specialist.requests.length, 2);
  assert.equal(result.replies[0]!.text, "Here is my actual answer.");
});

test("suggest_next rejects yourself and unknown agents with a readable error", async () => {
  const { room, events } = await setup({
    routerScript: [route(["research-lead"])],
    specialistScript: [
      callTool("s1", "suggest_next", { agent_id: "research-lead", reason: "me" }),
      callTool("s2", "suggest_next", { agent_id: "ghost", reason: "x" }),
      reply("ok"),
    ],
  });
  const result = await room.send("hello");
  assert.deepEqual(result.suggestions, []);
  const errors = events.filter((e) => e.type === "turn" && e.event.type === "tool_result" && e.event.isError);
  assert.equal(errors.length, 2);
});

test("the focus board reaches the agent and enables board_list", async () => {
  const { vault, room, specialist } = await setup({
    routerScript: [route(["floor-manager"])],
    specialistScript: [reply("PI-1 is active.")],
  });
  await mkdir(join(vault.root, "boards"), { recursive: true });
  await writeFile(vault.boardPath("pi.md"), "- PI-1 [active] Shorten time to insight\n");

  await room.send("What is active?", { focus: "pi.md" });
  const req = specialist.requests[0]!;
  assert.match(req.system, /Board in focus: pi\.md\n- PI-1 \[active\] Shorten time to insight/);
  assert.ok(req.tools.some((t) => t.name === "board_list"));
});

test("a missing focus board is not an error: no board section, no board tool", async () => {
  const { room, specialist } = await setup({
    routerScript: [route(["floor-manager"])],
    specialistScript: [reply("No board yet.")],
  });
  await room.send("What is active?", { focus: "pi.md" });
  const req = specialist.requests[0]!;
  assert.doesNotMatch(req.system, /Board in focus/);
  assert.ok(!req.tools.some((t) => t.name === "board_list"));
});

test("a focus path that escapes the boards folder is rejected before anything is written", async () => {
  const { vault, room } = await setup();
  await assert.rejects(() => room.send("hi", { focus: "../agents/floor-manager.md" }), /outside the boards folder/);
  await assert.rejects(() => room.send("hi", { focus: "notes.txt" }), /must be a \.md file/);
  assert.deepEqual(await readTail(vault.roomFile, 10), []);
});

test("agents only get the tools their file lists", async () => {
  const { agents } = await setup();
  const limited = agents.map((a) => (a.id === "synthesizer" ? { ...a, tools: ["notes_head"] } : a));
  const { room, specialist } = await setup({ agents: limited, specialistScript: [reply("ok")] });
  await room.send("@synthesizer hi");
  assert.deepEqual(specialist.requests[0]!.tools.map((t) => t.name), ["notes_head"]);
});

test("empty messages and unknown DM targets are rejected", async () => {
  const { room } = await setup();
  await assert.rejects(() => room.send("   "), /empty/);
  await assert.rejects(() => room.send("hi", { dm: "ghost" }), /No active agent/);
});

test("a retired agent cannot be addressed", async () => {
  const { agents } = await setup();
  const retired = agents.map((a) => (a.id === "synthesizer" ? { ...a, status: "retired" as const } : a));
  const { room } = await setup({ agents: retired });
  await assert.rejects(() => room.send("hi", { dm: "synthesizer" }), /No active agent/);
});

test("a failing provider surfaces the error but still returns the agent to idle", async () => {
  const { room, events, vault } = await setup({ routerScript: [route(["research-lead"])] }); // empty specialist script -> throws
  await assert.rejects(() => room.send("hello"), /script exhausted/);
  assert.deepEqual(
    events.filter((e) => e.type === "agent_state").map((e) => (e.type === "agent_state" ? e.state : "")),
    ["thinking", "idle"],
  );
  // The user's message is kept so nothing the user typed is lost.
  assert.deepEqual((await readTail(vault.roomFile, 10)).map((t) => t.from), ["user"]);
});

test("conversation context accumulates across messages", async () => {
  const { room, specialist } = await setup({
    specialistScript: [reply("First answer."), reply("Second answer.")],
  });
  await room.send("@research-lead first question");
  await room.send("@research-lead follow-up");
  const second = specialist.requests[1]!.messages;
  assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(second[1]!.role === "assistant" && second[1]!.text, "First answer.");
  assert.match(second[2]!.role === "user" ? second[2]!.text : "", /Kevin: @research-lead follow-up/);
});

test("an empty model reply is recorded as (no reply)", async () => {
  const { room } = await setup({ specialistScript: [reply("   ")] });
  const result = await room.send("@research-lead hello");
  assert.equal(result.replies[0]!.text, "(no reply)");
});

test("pinned notes written by an agent show up in its next prompt", async () => {
  const { room, specialist } = await setup({
    specialistScript: [
      callTool("p1", "notes_pin", { text: "Kevin prefers short answers\nUsers are compliance analysts" }),
      reply("Pinned."),
      reply("Ok."),
    ],
  });
  await room.send("@research-lead remember how I like answers");
  await room.send("@research-lead thanks");
  assert.match(specialist.requests[2]!.system, /Your pinned notes[^\n]*\nKevin prefers short answers\nUsers are compliance analysts/);
});
