import assert from "node:assert/strict";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgents } from "./agents.ts";
import { listApprovals } from "./approvals.ts";
import { createBoardWriteTools } from "./boardWriteTools.ts";
import { checkHierarchy, loadBoards } from "./hierarchy.ts";
import { KNOWN_TOOLS } from "./room.ts";
import { openVault } from "./vault.ts";

const SAMPLE = fileURLToPath(new URL("../../../sample-vault", import.meta.url));

async function setup(actor: string, defaultBoard?: string) {
  const root = await mkdtemp(join(tmpdir(), "am-bwt-"));
  await cp(SAMPLE, root, { recursive: true });
  const vault = openVault(root);
  const { agents } = await loadAgents(vault.agentsDir, [...KNOWN_TOOLS]);
  const tools = createBoardWriteTools({
    vault,
    agents,
    actor,
    ...(defaultBoard ? { defaultBoard } : {}),
    clock: { now: () => new Date(Date.UTC(2026, 9, 28, 18, 0, 0)), newId: () => "x" },
  });
  const run = async (name: string, input: Record<string, unknown>): Promise<string> => tools.find((t) => t.name === name)!.run(input);
  return { vault, run, agents };
}

const TASKS = "tasks/interview-synthesis.md";

test("an agent adds a task at once: next id, creator set, hierarchy still clean", async () => {
  const { vault, run } = await setup("synthesizer", TASKS);
  const out = await run("board_add", { title: "Cluster the quotes", parent: "SP-1", done_when: "clusters reviewed" });
  assert.match(out, /Added T-4 to tasks\/interview-synthesis\.md/);
  const text = await readFile(vault.boardPath(TASKS), "utf8");
  assert.match(text, /- T-4 \[proposed\] Cluster the quotes \| creator: synthesizer \| parent: SP-1 \| done_when: clusters reviewed/);
  assert.deepEqual(checkHierarchy(await loadBoards(vault)), []);
  assert.deepEqual(await listApprovals(vault), []);
});

test("adding a task needs a real sprint parent", async () => {
  const { run } = await setup("synthesizer", TASKS);
  await assert.rejects(() => run("board_add", { title: "Orphan" }), /needs a parent sprint/);
  await assert.rejects(() => run("board_add", { title: "Bad", parent: "PI-1" }), /must be a sprint item/);
  await assert.rejects(() => run("board_add", { title: "Ghost", parent: "SP-9" }), /does not exist/);
});

test("changing your own task is immediate, and so is a supervisor changing it", async () => {
  const own = await setup("synthesizer", TASKS);
  assert.match(await own.run("board_set_status", { id: "T-3", status: "active" }), /T-3 is now active/);
  const boss = await setup("research-lead", TASKS);
  assert.match(await boss.run("board_edit", { id: "T-3", owner: "research-lead" }), /Updated T-3/);
  assert.match(await readFile(boss.vault.boardPath(TASKS), "utf8"), /- T-3 \[proposed\] .*owner: research-lead \| creator: synthesizer/);
});

test("editing someone else's task, when not their supervisor, files a request and changes nothing", async () => {
  const { vault, run } = await setup("synthesizer", TASKS);
  const before = await readFile(vault.boardPath(TASKS), "utf8");
  const out = await run("board_set_status", { id: "T-1", status: "dropped", why: "Looks redundant" });
  assert.match(out, /Not changed yet.*AP-1.*waiting.*research-lead/);
  assert.equal(await readFile(vault.boardPath(TASKS), "utf8"), before);
  const [ap] = await listApprovals(vault);
  assert.equal(ap!.id, "AP-1");
  assert.equal(ap!.status, "pending");
  assert.equal(ap!.actor, "synthesizer");
  assert.equal(ap!.why, "Looks redundant");
  assert.deepEqual(ap!.approvers, ["research-lead"]);
  assert.deepEqual(ap!.change, { kind: "set_status", id: "T-1", status: "dropped" });
  assert.equal(ap!.summary, "Mark T-1 as dropped");
});

test("sprint changes from an agent go to the Floor manager; the Floor manager writes directly", async () => {
  const a = await setup("synthesizer");
  const out = await a.run("board_add", { board: "sprint.md", title: "Interview more users", parent: "PI-1" });
  assert.match(out, /Not changed yet.*floor-manager/);
  assert.match(await readFile(a.vault.boardPath("sprint.md"), "utf8"), /^(?!.*Interview more users)/s);
  const f = await setup("floor-manager");
  assert.match(await f.run("board_add", { board: "sprint.md", title: "Interview more users", parent: "PI-1" }), /Added SP-3/);
});

test("PI changes escalate through the Floor manager to Kevin", async () => {
  const { vault, run } = await setup("research-lead");
  await run("board_set_status", { board: "pi.md", id: "PI-2", status: "active" });
  const [ap] = await listApprovals(vault);
  assert.deepEqual(ap!.approvers, ["floor-manager", "user"]);
  assert.equal(ap!.level, "pi");
});

test("request ids count up, and a bad board or item is a readable error", async () => {
  const { vault, run } = await setup("synthesizer");
  await run("board_set_status", { board: "pi.md", id: "PI-1", status: "done" });
  await run("board_set_status", { board: "pi.md", id: "PI-2", status: "done" });
  assert.deepEqual((await listApprovals(vault)).map((a) => a.id), ["AP-1", "AP-2"]);
  await assert.rejects(() => run("board_list", {}), /Say which board/);
  await assert.rejects(() => run("board_list", { board: "agents/x.md" }), /not a PI, sprint or task board/);
  await assert.rejects(() => run("board_list", { board: "../agents/x.md" }), /outside the boards folder/);
  await assert.rejects(() => run("board_set_status", { board: "pi.md", id: "PI-9", status: "done" }), /No item PI-9/);
  await assert.rejects(() => run("board_add", { board: "tasks/nope.md", title: "x", parent: "SP-1" }), /No board named/);
  await assert.rejects(() => run("board_edit", { board: "pi.md", id: "PI-1" }), /Nothing to change/);
  await assert.rejects(() => run("board_add", { board: "pi.md", title: "a | b" }), /cannot contain/);
});

test("board_list reads any board by name", async () => {
  const { run } = await setup("synthesizer", "pi.md");
  assert.equal(JSON.parse(await run("board_list", {})).length, 3);
  assert.equal(JSON.parse(await run("board_list", { board: TASKS })).length, 3);
});
