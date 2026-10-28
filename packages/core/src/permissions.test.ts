import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDef } from "./agents.ts";
import { decide, isSupervisor, levelOfId, nextId, parentProblem } from "./permissions.ts";
import type { LevelConfig } from "./permissions.ts";

function agent(id: string, reportsTo: string, extra: Partial<AgentDef> = {}): AgentDef {
  return {
    id, name: id, role: id, goal: "", avatar: id, accent: "gray", modelTier: "specialist",
    reportsTo, tokenCap: 1000, tools: [], isOrchestrator: false, status: "active", charter: "", ...extra,
  };
}

const agents = [
  agent("floor-manager", "user", { isOrchestrator: true }),
  agent("research-lead", "floor-manager"),
  agent("synthesizer", "research-lead"),
  agent("skeptic", "floor-manager"),
  agent("old-timer", "floor-manager", { status: "retired" }),
];

test("levelOfId matches the configured prefixes and nothing else", () => {
  assert.equal(levelOfId("PI-1"), "pi");
  assert.equal(levelOfId("SP-12"), "sprint");
  assert.equal(levelOfId("T-3"), "task");
  assert.equal(levelOfId("T-"), null);
  assert.equal(levelOfId("TASK-3"), null);
  assert.equal(levelOfId("PI-1x"), null);
});

test("a different prefix config is a one-line swap", () => {
  const jira: LevelConfig = { pi: { prefix: "GOAL" }, sprint: { prefix: "SPR" }, task: { prefix: "WORK" } };
  assert.equal(levelOfId("WORK-9", jira), "task");
  assert.equal(levelOfId("T-9", jira), null);
  assert.equal(nextId("sprint", ["SPR-2"], jira), "SPR-3");
});

test("nextId goes one past the highest number, never reusing ids", () => {
  assert.equal(nextId("task", []), "T-1");
  assert.equal(nextId("task", ["T-1", "T-7", "SP-40", "junk"]), "T-8");
});

test("parentProblem requires the next level up and leaves PI parents free", () => {
  assert.equal(parentProblem("pi", "Q4"), null);
  assert.equal(parentProblem("pi", undefined), null);
  assert.equal(parentProblem("sprint", "PI-1"), null);
  assert.match(parentProblem("sprint", undefined) ?? "", /needs a parent pi/);
  assert.match(parentProblem("sprint", "T-1") ?? "", /must be a pi item/);
  assert.equal(parentProblem("task", "SP-2"), null);
  assert.match(parentProblem("task", "PI-1") ?? "", /must be a sprint item/);
});

test("the orchestrator is above everyone; others follow reports_to", () => {
  assert.ok(isSupervisor("floor-manager", "synthesizer", agents));
  assert.ok(isSupervisor("research-lead", "synthesizer", agents));
  assert.ok(isSupervisor("floor-manager", "research-lead", agents));
  assert.ok(!isSupervisor("synthesizer", "research-lead", agents));
  assert.ok(!isSupervisor("skeptic", "synthesizer", agents));
  assert.ok(!isSupervisor("research-lead", "research-lead", agents));
  assert.ok(!isSupervisor("floor-manager", "ghost", agents));
});

test("Kevin can do anything", () => {
  for (const level of ["pi", "sprint", "task"] as const) {
    assert.deepEqual(decide({ actor: "user", action: "delete", level, creator: "skeptic", agents }), { outcome: "allow" });
  }
});

test("unknown and retired agents are denied", () => {
  assert.equal(decide({ actor: "ghost", action: "edit", level: "task", creator: "ghost", agents }).outcome, "deny");
  assert.equal(decide({ actor: "old-timer", action: "create", level: "task", agents }).outcome, "deny");
});

test("PI changes escalate to the Floor manager and then Kevin; the Floor manager's go to Kevin", () => {
  const d = decide({ actor: "research-lead", action: "edit", level: "pi", creator: "research-lead", agents });
  assert.deepEqual(d.outcome === "request" && d.approvers, ["floor-manager", "user"]);
  const f = decide({ actor: "floor-manager", action: "create", level: "pi", agents });
  assert.deepEqual(f.outcome === "request" && f.approvers, ["user"]);
});

test("sprint changes go to the Floor manager, who can change them directly", () => {
  const d = decide({ actor: "synthesizer", action: "create", level: "sprint", agents });
  assert.deepEqual(d.outcome === "request" && d.approvers, ["floor-manager"]);
  assert.equal(decide({ actor: "floor-manager", action: "edit", level: "sprint", creator: "skeptic", agents }).outcome, "allow");
});

test("task board: anyone creates; creator and supervisors edit; others ask the creator", () => {
  assert.equal(decide({ actor: "skeptic", action: "create", level: "task", agents }).outcome, "allow");
  assert.equal(decide({ actor: "synthesizer", action: "edit", level: "task", creator: "synthesizer", agents }).outcome, "allow");
  assert.equal(decide({ actor: "research-lead", action: "delete", level: "task", creator: "synthesizer", agents }).outcome, "allow");
  assert.equal(decide({ actor: "floor-manager", action: "edit", level: "task", creator: "skeptic", agents }).outcome, "allow");
  const d = decide({ actor: "skeptic", action: "edit", level: "task", creator: "synthesizer", agents });
  assert.deepEqual(d.outcome === "request" && d.approvers, ["synthesizer"]);
});

test("task items made by Kevin ask Kevin; items from retired creators ask the Floor manager", () => {
  const a = decide({ actor: "skeptic", action: "edit", level: "task", creator: "user", agents });
  assert.deepEqual(a.outcome === "request" && a.approvers, ["user"]);
  const b = decide({ actor: "skeptic", action: "edit", level: "task", creator: "old-timer", agents });
  assert.deepEqual(b.outcome === "request" && b.approvers, ["floor-manager"]);
});

test("editing an existing task item without a known creator is denied, not guessed", () => {
  assert.equal(decide({ actor: "skeptic", action: "edit", level: "task", agents }).outcome, "deny");
});
