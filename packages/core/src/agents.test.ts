import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgents, parseAgent, validateRoster } from "./agents.ts";
import type { AgentDef } from "./agents.ts";
import { KNOWN_TOOLS } from "./room.ts";

const SAMPLE_AGENTS = fileURLToPath(new URL("../../../sample-vault/agents", import.meta.url));

const minimal = (extra = "") => `---\nname: Test\nrole: Tester\n${extra}---\nCharter.`;

test("a minimal agent gets sensible defaults", () => {
  const { agent, issues } = parseAgent("tester", minimal());
  assert.ok(agent);
  assert.equal(agent.modelTier, "specialist");
  assert.equal(agent.reportsTo, "user");
  assert.equal(agent.tokenCap, 1500);
  assert.equal(agent.avatar, "tester");
  assert.equal(agent.status, "active");
  assert.deepEqual(agent.tools, []);
  assert.equal(agent.charter, "Charter.");
  assert.deepEqual(issues, []);
});

test("missing name or role is an error and yields no agent", () => {
  const { agent, issues } = parseAgent("x", "---\nrole: R\n---\nbody");
  assert.equal(agent, null);
  assert.ok(issues.some((i) => i.level === "error" && /name/.test(i.message)));
});

test("bad values are reported", () => {
  const r = parseAgent(
    "x",
    minimal("model_tier: huge\ntoken_cap: -5\nstatus: asleep\nis_orchestrator: maybe\ntools: nope\n"),
  );
  assert.equal(r.agent, null);
  assert.equal(r.issues.filter((i) => i.level === "error").length, 5);
});

test("unknown fields and an empty charter are warnings only", () => {
  const r = parseAgent("x", "---\nname: A\nrole: B\nfavorite_color: red\n---\n");
  assert.ok(r.agent);
  assert.equal(r.issues.filter((i) => i.level === "warning").length, 2);
});

test("invalid file name is an error", () => {
  const r = parseAgent("Bad Name", minimal());
  assert.equal(r.agent, null);
});

function agent(over: Partial<AgentDef> & { id: string }): AgentDef {
  return {
    name: over.id,
    role: "r",
    goal: "",
    avatar: over.id,
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

test("roster needs exactly one active orchestrator", () => {
  assert.ok(validateRoster([agent({ id: "a" })]).some((i) => /exactly one/.test(i.message)));
  const two = validateRoster([
    agent({ id: "a", isOrchestrator: true }),
    agent({ id: "b", isOrchestrator: true }),
  ]);
  assert.ok(two.some((i) => /Only one orchestrator/.test(i.message)));
  const ok = validateRoster([agent({ id: "a", isOrchestrator: true }), agent({ id: "b", reportsTo: "a" })]);
  assert.deepEqual(ok, []);
});

test("a retired orchestrator does not count", () => {
  const issues = validateRoster([
    agent({ id: "a", isOrchestrator: true, status: "retired" }),
    agent({ id: "b", isOrchestrator: true }),
  ]);
  assert.deepEqual(issues, []);
});

test("reporting lines must exist and must not loop", () => {
  const issues = validateRoster([
    agent({ id: "boss", isOrchestrator: true }),
    agent({ id: "a", reportsTo: "ghost" }),
    agent({ id: "x", reportsTo: "y" }),
    agent({ id: "y", reportsTo: "x" }),
    agent({ id: "me", reportsTo: "me" }),
  ]);
  assert.ok(issues.some((i) => i.agentId === "a" && /not an agent/.test(i.message)));
  assert.ok(issues.some((i) => /loops back/.test(i.message)));
  assert.ok(issues.some((i) => i.agentId === "me" && /itself/.test(i.message)));
});

test("missing qa_partner and unknown tools are warnings", () => {
  const issues = validateRoster(
    [agent({ id: "a", isOrchestrator: true, qaPartner: "skeptic", tools: ["board_set_status", "notes_head"] })],
    [...KNOWN_TOOLS],
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.level === "warning"));
});

test("the sample vault's starter agents load cleanly", async () => {
  const { agents, issues } = await loadAgents(SAMPLE_AGENTS, [...KNOWN_TOOLS]);
  assert.deepEqual(issues, []);
  assert.deepEqual(agents.map((a) => a.id), ["floor-manager", "research-lead", "synthesizer"]);
  assert.equal(agents.filter((a) => a.isOrchestrator).length, 1);
});

test("loadAgents reports a missing folder and skips underscore files", async () => {
  const missing = await loadAgents(join(tmpdir(), "am-does-not-exist"));
  assert.equal(missing.agents.length, 0);
  assert.equal(missing.issues[0]?.level, "error");

  const dir = await mkdtemp(join(tmpdir(), "am-agents-"));
  await writeFile(join(dir, "boss.md"), minimal("is_orchestrator: true\n"));
  await writeFile(join(dir, "_template.md"), "not an agent");
  await writeFile(join(dir, "broken.md"), "garbage");
  const loaded = await loadAgents(dir);
  assert.deepEqual(loaded.agents.map((a) => a.id), ["boss"]);
  assert.ok(loaded.issues.some((i) => i.agentId === "broken" && i.level === "error"));
});
