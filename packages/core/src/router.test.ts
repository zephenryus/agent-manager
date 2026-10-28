import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDef } from "./agents.ts";
import { callTool, createFakeProvider, reply } from "./providers/fake.ts";
import { createLlmRouter, createStaticRouter, findMentions, normalizeDecision } from "./router.ts";
import { ProviderAuthError } from "./types.ts";
import type { ModelResponse } from "./types.ts";

function agent(id: string, over: Partial<AgentDef> = {}): AgentDef {
  return {
    id,
    name: id,
    role: `${id} role`,
    goal: "",
    avatar: id,
    accent: "gray",
    modelTier: "specialist",
    reportsTo: "user",
    tokenCap: 1500,
    tools: [],
    isOrchestrator: false,
    status: "active",
    charter: "c",
    ...over,
  };
}

const roster = [
  agent("floor-manager", { isOrchestrator: true }),
  agent("research-lead"),
  agent("synthesizer"),
  agent("old-timer", { status: "retired" }),
];
const none = { inputTokens: 0, outputTokens: 0 };

test("findMentions matches active agents in order, once", () => {
  assert.deepEqual(findMentions("@synthesizer and @research-lead, also @synthesizer", roster), [
    "synthesizer",
    "research-lead",
  ]);
  assert.deepEqual(findMentions("email me at a@synthesizer.com", roster), []);
  assert.deepEqual(findMentions("(@research-lead) thoughts?", roster), ["research-lead"]);
  assert.deepEqual(findMentions("@old-timer @nobody", roster), []);
  assert.deepEqual(findMentions("@Research-Lead hi", roster), ["research-lead"]);
});

test("static router always picks the orchestrator", async () => {
  const d = await createStaticRouter("floor-manager").route({ text: "anything", recent: [] });
  assert.deepEqual(d.responders, ["floor-manager"]);
  assert.equal(d.source, "static");
});

test("llm router uses the route tool's answer", async () => {
  const provider = createFakeProvider([
    callTool("r1", "route", {
      responders: ["synthesizer"],
      suggestions: [{ agent_id: "research-lead", reason: "may need more interviews" }],
      reason: "notes to analyze",
    }),
  ]);
  const router = createLlmRouter({ provider, agents: roster, orchestratorId: "floor-manager" });
  const d = await router.route({ text: "Here are my interview notes...", recent: [] });
  assert.deepEqual(d.responders, ["synthesizer"]);
  assert.deepEqual(d.suggestions, [{ agentId: "research-lead", reason: "may need more interviews" }]);
  assert.equal(d.source, "llm");
  assert.deepEqual(d.usage, { inputTokens: 10, outputTokens: 5 });

  // The prompt lists the team (active only) and offers exactly one tool.
  const req = provider.requests[0]!;
  assert.match(req.system, /research-lead: research-lead role/);
  assert.doesNotMatch(req.system, /old-timer/);
  assert.deepEqual(req.tools.map((t) => t.name), ["route"]);
});

test("llm router includes recent messages for follow-ups", async () => {
  const provider = createFakeProvider([callTool("r1", "route", { responders: ["synthesizer"], reason: "x" })]);
  const router = createLlmRouter({ provider, agents: roster, orchestratorId: "floor-manager" });
  await router.route({
    text: "and the second theme?",
    recent: [{ id: "1", ts: "t", from: "synthesizer", text: "Theme one is trust." }],
  });
  const first = provider.requests[0]!.messages[0]!;
  assert.equal(first.role, "user");
  assert.match(first.role === "user" ? first.text : "", /synthesizer: Theme one is trust\./);
});

test("unknown ids are dropped, duplicates removed, cap applied", () => {
  const d = normalizeDecision(
    { responders: ["ghost", "synthesizer", "synthesizer", "research-lead", "floor-manager"], reason: "r" },
    roster.filter((a) => a.status === "active"),
    "floor-manager",
    2,
    none,
  );
  assert.deepEqual(d.responders, ["synthesizer", "research-lead"]);
});

test("suggestions exclude responders, unknown agents and duplicates", () => {
  const d = normalizeDecision(
    {
      responders: ["synthesizer"],
      suggestions: [
        { agent_id: "synthesizer", reason: "already answering" },
        { agent_id: "ghost", reason: "x" },
        { agent_id: "research-lead", reason: "first" },
        { agent_id: "research-lead", reason: "dup" },
        "garbage",
      ],
      reason: "r",
    },
    roster.filter((a) => a.status === "active"),
    "floor-manager",
    2,
    none,
  );
  assert.deepEqual(d.suggestions, [{ agentId: "research-lead", reason: "first" }]);
});

test("no valid responder falls back to the orchestrator", () => {
  const d = normalizeDecision({ responders: ["ghost"], reason: "r" }, roster, "floor-manager", 2, none);
  assert.deepEqual(d.responders, ["floor-manager"]);
  assert.equal(d.source, "fallback");
});

test("no tool call falls back to the orchestrator but keeps the usage", async () => {
  const provider = createFakeProvider([reply("I think the researcher.")]);
  const router = createLlmRouter({ provider, agents: roster, orchestratorId: "floor-manager" });
  const d = await router.route({ text: "hi", recent: [] });
  assert.deepEqual(d.responders, ["floor-manager"]);
  assert.equal(d.source, "fallback");
  assert.deepEqual(d.usage, { inputTokens: 10, outputTokens: 5 });
});

test("a provider failure falls back, but an auth failure is surfaced", async () => {
  const broken = {
    id: "broken",
    async complete(): Promise<ModelResponse> {
      throw new Error("boom");
    },
  };
  const d = await createLlmRouter({ provider: broken, agents: roster, orchestratorId: "floor-manager" }).route({
    text: "hi",
    recent: [],
  });
  assert.equal(d.source, "fallback");
  assert.match(d.reason, /boom/);

  const expired = {
    id: "expired",
    async complete(): Promise<ModelResponse> {
      throw new ProviderAuthError("expired", "refresh");
    },
  };
  await assert.rejects(
    () => createLlmRouter({ provider: expired, agents: roster, orchestratorId: "floor-manager" }).route({ text: "hi", recent: [] }),
    ProviderAuthError,
  );
});
