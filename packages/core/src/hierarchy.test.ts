import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ancestors, checkHierarchy, levelOfBoard, listBoardNames, loadBoards, parseBoard } from "./hierarchy.ts";
import { openVault } from "./vault.ts";

const SAMPLE = fileURLToPath(new URL("../../../sample-vault", import.meta.url));

test("levelOfBoard maps file names to levels", () => {
  assert.equal(levelOfBoard("pi.md"), "pi");
  assert.equal(levelOfBoard("sprint.md"), "sprint");
  assert.equal(levelOfBoard("tasks/research.md"), "task");
  assert.equal(levelOfBoard("tasks\\research.md"), "task");
  assert.equal(levelOfBoard("tasks/a/b.md"), null);
  assert.equal(levelOfBoard("notes.md"), null);
});

test("the sample vault lists its boards in order and has a clean hierarchy", async () => {
  const vault = openVault(SAMPLE);
  assert.deepEqual(await listBoardNames(vault), ["pi.md", "sprint.md", "tasks/interview-synthesis.md"]);
  const boards = await loadBoards(vault);
  assert.deepEqual(boards.map((b) => b.level), ["pi", "sprint", "task"]);
  assert.equal(boards[2]!.title, "Interview synthesis (sample data, fake)");
  assert.deepEqual(checkHierarchy(boards), []);
});

test("listBoardNames returns nothing when there is no boards folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-hier-"));
  assert.deepEqual(await listBoardNames(openVault(dir)), []);
});

test("listBoardNames finds task boards and ignores other files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-hier-"));
  await mkdir(join(dir, "boards", "tasks"), { recursive: true });
  await writeFile(join(dir, "boards", "tasks", "b.md"), "# B\n");
  await writeFile(join(dir, "boards", "tasks", "a.md"), "# A\n");
  await writeFile(join(dir, "boards", "pi.md"), "# PI\n");
  await writeFile(join(dir, "boards", "readme.txt"), "x");
  assert.deepEqual(await listBoardNames(openVault(dir)), ["pi.md", "tasks/a.md", "tasks/b.md"]);
});

test("checkHierarchy flags orphans, wrong boards, duplicates and closed parents", () => {
  const boards = [
    parseBoard("pi.md", ["- PI-1 [done] Goal", "- PI-2 [active] Other"].join("\n")),
    parseBoard(
      "sprint.md",
      [
        "- SP-1 [active] Under a closed goal | parent: PI-1",
        "- SP-2 [active] No parent",
        "- SP-3 [active] Ghost parent | parent: PI-9",
        "- SP-4 [active] Wrong kind of parent | parent: T-1",
        "- T-5 [active] A task on the sprint board | parent: SP-1",
      ].join("\n"),
    ),
    parseBoard("tasks/x.md", ["- T-1 [active] Fine | parent: SP-1", "- T-1 [active] Same id again | parent: SP-1"].join("\n")),
  ];
  const kinds = checkHierarchy(boards).map((i) => `${i.itemId}:${i.kind}`).sort();
  assert.deepEqual(kinds, [
    "SP-1:closed_parent",
    "SP-2:missing_parent",
    "SP-3:unknown_parent",
    "SP-4:bad_parent",
    "T-1:duplicate_id",
    "T-5:wrong_board",
  ]);
});

test("a closed child under a closed parent is fine, and PI items need no parent", () => {
  const boards = [
    parseBoard("pi.md", "- PI-1 [done] Goal"),
    parseBoard("sprint.md", "- SP-1 [done] Finished | parent: PI-1"),
  ];
  assert.deepEqual(checkHierarchy(boards), []);
});

test("ancestors walks up to the top goal and survives loops and gaps", () => {
  const boards = [
    parseBoard("pi.md", "- PI-1 [active] Top | parent: Q4"),
    parseBoard("sprint.md", "- SP-1 [active] Mid | parent: PI-1"),
    parseBoard("tasks/x.md", "- T-1 [active] Leaf | parent: SP-1\n- T-2 [active] Lost | parent: SP-9"),
  ];
  assert.deepEqual(ancestors(boards, "T-1").map((i) => i.id), ["SP-1", "PI-1"]);
  assert.deepEqual(ancestors(boards, "T-2"), []);
  const loop = [parseBoard("pi.md", "- PI-1 [active] A | parent: PI-2\n- PI-2 [active] B | parent: PI-1")];
  assert.deepEqual(ancestors(loop, "PI-1").map((i) => i.id), ["PI-2"]);
});
