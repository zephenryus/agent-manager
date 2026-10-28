import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDef } from "./agents.ts";
import { buildContext, buildMessages } from "./context.ts";
import type { ContextInput } from "./context.ts";
import type { TranscriptEntry } from "./transcript.ts";

function agent(id: string, name: string, over: Partial<AgentDef> = {}): AgentDef {
  return {
    id,
    name,
    role: `${name} role`,
    goal: "",
    avatar: id,
    accent: "gray",
    modelTier: "specialist",
    reportsTo: "user",
    tokenCap: 1500,
    tools: [],
    isOrchestrator: false,
    status: "active",
    charter: `Charter of ${name}.`,
    ...over,
  };
}

const me = agent("research-lead", "Research lead");
const roster = [agent("floor-manager", "Floor manager", { isOrchestrator: true }), me, agent("synthesizer", "Synthesizer")];

const e = (from: string, text: string): TranscriptEntry => ({ id: text, ts: "t", from, text });

function input(transcript: TranscriptEntry[], over: Partial<ContextInput> = {}): ContextInput {
  return { agent: me, roster, transcript, pinned: [], logTail: [], mode: "room", userName: "Kevin", ...over };
}

test("own replies are assistant turns; others are labeled user turns", () => {
  const messages = buildMessages(
    input([e("user", "Plan discovery"), e("research-lead", "Here is a plan"), e("user", "Thanks"), e("synthesizer", "I can help")]),
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.equal(messages[0]!.role === "user" && messages[0]!.text, "Kevin: Plan discovery");
  assert.equal(messages[1]!.role === "assistant" && messages[1]!.text, "Here is a plan");
  assert.equal(
    messages[2]!.role === "user" && messages[2]!.text,
    "Kevin: Thanks\n\n[Synthesizer]: I can help",
  );
});

test("consecutive same-role entries are merged", () => {
  const messages = buildMessages(input([e("user", "a"), e("user", "b"), e("floor-manager", "c")]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role === "user" && messages[0]!.text, "Kevin: a\n\nKevin: b\n\n[Floor manager]: c");
});

test("the conversation always starts and ends with a user message", () => {
  const startsWithMe = buildMessages(input([e("research-lead", "I spoke first")]));
  assert.deepEqual(startsWithMe.map((m) => m.role), ["user", "assistant", "user"]);

  const empty = buildMessages(input([]));
  assert.deepEqual(empty.map((m) => m.role), ["user"]);
});

test("system messages and unknown speakers are labeled", () => {
  const messages = buildMessages(input([e("system", "Budget at 80%"), e("mystery", "hello")]));
  assert.equal(messages[0]!.role === "user" && messages[0]!.text, "[system] Budget at 80%\n\n[mystery]: hello");
});

test("the system prompt has charter, identity, teammates and mode", () => {
  const { system } = buildContext(input([e("user", "hi")]));
  assert.match(system, /^Charter of Research lead\./);
  assert.match(system, /You are Research lead, Research lead role\. Your id is "research-lead"\./);
  assert.match(system, /- floor-manager: Floor manager, Floor manager role/);
  assert.match(system, /- synthesizer: Synthesizer/);
  assert.doesNotMatch(system, /- research-lead:/);
  assert.match(system, /team room with Kevin/);
  assert.match(system, /suggest_next/);
});

test("dm mode says private chat and omits the room hint", () => {
  const { system } = buildContext(input([e("user", "hi")], { mode: "dm" }));
  assert.match(system, /private chat with Kevin/);
  assert.doesNotMatch(system, /suggest_next/);
});

test("notes and the focus board appear only when present", () => {
  const plain = buildContext(input([e("user", "hi")])).system;
  assert.doesNotMatch(plain, /pinned notes/);
  assert.doesNotMatch(plain, /Board in focus/);

  const rich = buildContext(
    input([e("user", "hi")], {
      pinned: ["Top fact", "Second fact"],
      logTail: ["- 2026-10-27 learned x"],
      focus: { name: "pi.md", text: "- PI-1 [active] Goal\n" },
    }),
  ).system;
  assert.match(rich, /Your pinned notes[^\n]*\nTop fact\nSecond fact/);
  assert.match(rich, /Your recent log[^\n]*\n- 2026-10-27 learned x/);
  assert.match(rich, /Board in focus: pi\.md\n- PI-1 \[active\] Goal$/);
});

test("retired teammates are not listed", () => {
  const { system } = buildContext(
    input([e("user", "hi")], { roster: [...roster, agent("old", "Old timer", { status: "retired" })] }),
  );
  assert.doesNotMatch(system, /Old timer/);
});

test("without a user name the prompt says 'the user'", () => {
  const { system, messages } = buildContext({ ...input([e("user", "hi")]), userName: undefined });
  assert.match(system, /team room with the user/);
  assert.equal(messages[0]!.role === "user" && messages[0]!.text, "the user: hi");
});
