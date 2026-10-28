import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ApprovalError, createApproval, getApproval, listApprovals, resolveApproval } from "./approvals.ts";
import type { NewApproval } from "./approvals.ts";
import { checkHierarchy, loadBoards } from "./hierarchy.ts";
import { openVault } from "./vault.ts";

const SAMPLE = fileURLToPath(new URL("../../../sample-vault", import.meta.url));
const clock = { now: () => new Date(Date.UTC(2026, 9, 28, 19, 0, 0)), newId: () => "x" };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "am-appr-"));
  await cp(SAMPLE, root, { recursive: true });
  return openVault(root);
}

const sprintAdd: NewApproval = {
  actor: "synthesizer",
  board: "sprint.md",
  level: "sprint",
  why: "We need more interviews",
  change: { kind: "add", title: "Interview more users", status: "proposed", fields: { parent: "PI-1" } },
  approvers: ["floor-manager"],
  needed: "Sprint board changes go to the Floor manager",
};
const piStatus: NewApproval = {
  actor: "research-lead",
  board: "pi.md",
  level: "pi",
  why: "",
  change: { kind: "set_status", id: "PI-2", status: "active" },
  approvers: ["floor-manager", "user"],
  needed: "PI board changes need the user's approval",
};

test("the user approving applies the change, credits the requester as creator and records who decided", async () => {
  const vault = await setup();
  const ap = await createApproval(vault, sprintAdd, clock);
  const done = await resolveApproval({ vault, id: ap.id, decision: "approve", by: "user", reason: "Good call", clock });
  assert.equal(done.status, "approved");
  assert.deepEqual(done.history, [{ by: "user", at: "2026-10-28T19:00:00.000Z", action: "approve", reason: "Good call" }]);
  assert.match(await readFile(vault.boardPath("sprint.md"), "utf8"), /- SP-3 \[proposed\] Interview more users \| creator: synthesizer \| parent: PI-1/);
  assert.deepEqual(checkHierarchy(await loadBoards(vault)), []);
  assert.equal((await getApproval(vault, ap.id))!.status, "approved");
});

test("rejecting changes nothing on the board", async () => {
  const vault = await setup();
  const before = await readFile(vault.boardPath("sprint.md"), "utf8");
  const ap = await createApproval(vault, sprintAdd, clock);
  const done = await resolveApproval({ vault, id: ap.id, decision: "reject", by: "floor-manager", reason: "Not this sprint", clock });
  assert.equal(done.status, "rejected");
  assert.equal(await readFile(vault.boardPath("sprint.md"), "utf8"), before);
});

test("a PI request passes up one level at a time: the Floor manager first, then Kevin", async () => {
  const vault = await setup();
  const ap = await createApproval(vault, piStatus, clock);
  await assert.rejects(() => resolveApproval({ vault, id: ap.id, decision: "approve", by: "synthesizer", clock }), /waiting for floor-manager/);
  const mid = await resolveApproval({ vault, id: ap.id, decision: "approve", by: "floor-manager", clock });
  assert.equal(mid.status, "pending");
  assert.equal(mid.stage, 1);
  assert.match(await readFile(vault.boardPath("pi.md"), "utf8"), /- PI-2 \[proposed\]/);
  await assert.rejects(() => resolveApproval({ vault, id: ap.id, decision: "approve", by: "floor-manager", clock }), /waiting for user/);
  const done = await resolveApproval({ vault, id: ap.id, decision: "approve", by: "user", clock });
  assert.equal(done.status, "approved");
  assert.deepEqual(done.history!.map((h) => h.by), ["floor-manager", "user"]);
  assert.match(await readFile(vault.boardPath("pi.md"), "utf8"), /- PI-2 \[active\]/);
});

test("Kevin can approve at any stage and skip the chain", async () => {
  const vault = await setup();
  const ap = await createApproval(vault, piStatus, clock);
  const done = await resolveApproval({ vault, id: ap.id, decision: "approve", by: "user", clock });
  assert.equal(done.status, "approved");
  assert.match(await readFile(vault.boardPath("pi.md"), "utf8"), /- PI-2 \[active\]/);
});

test("a request that no longer fits the board fails as stale and stays pending", async () => {
  const vault = await setup();
  const ap = await createApproval(vault, { ...piStatus, change: { kind: "set_status", id: "PI-9", status: "done" } }, clock);
  await assert.rejects(
    () => resolveApproval({ vault, id: ap.id, decision: "approve", by: "user", clock }),
    (err: unknown) => err instanceof ApprovalError && err.code === "stale" && /No item PI-9/.test(err.message),
  );
  assert.equal((await getApproval(vault, ap.id))!.status, "pending");
  assert.equal((await resolveApproval({ vault, id: ap.id, decision: "reject", by: "user", clock })).status, "rejected");
});

test("resolving twice, or resolving a missing request, is a clear error", async () => {
  const vault = await setup();
  const ap = await createApproval(vault, sprintAdd, clock);
  await resolveApproval({ vault, id: ap.id, decision: "reject", by: "user", clock });
  await assert.rejects(() => resolveApproval({ vault, id: ap.id, decision: "approve", by: "user", clock }), /already rejected/);
  await assert.rejects(() => resolveApproval({ vault, id: "AP-99", decision: "approve", by: "user", clock }), /No approval request/);
  await assert.rejects(() => resolveApproval({ vault, id: "../x", decision: "approve", by: "user", clock }), /Invalid approval id/);
});

test("listApprovals filters by status, oldest first, and skips damaged files", async () => {
  const vault = await setup();
  const a = await createApproval(vault, sprintAdd, clock);
  const b = await createApproval(vault, piStatus, clock);
  await writeFile(join(vault.approvalsDir, "AP-7.json"), "{ not json");
  await resolveApproval({ vault, id: a.id, decision: "reject", by: "user", clock });
  assert.deepEqual((await listApprovals(vault)).map((x) => x.id), ["AP-1", "AP-2"]);
  assert.deepEqual((await listApprovals(vault, { status: "pending" })).map((x) => x.id), [b.id]);
  assert.deepEqual(await listApprovals(await (async () => openVault(await mkdtemp(join(tmpdir(), "am-empty-"))))()), []);
});
