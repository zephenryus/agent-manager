import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NEW_BOARD_RE, blankBoard, ensureBoardFiles } from "./boardFiles.ts";
import { checkHierarchy, levelOfBoard, loadBoards } from "./hierarchy.ts";
import { listItems } from "./board.ts";
import { openVault } from "./vault.ts";

test("blank boards have a title and the right section, and no items", () => {
  assert.equal(blankBoard("sprint.md"), "# Sprint board\n\n## Goals\n");
  assert.equal(blankBoard("pi.md"), "# PI board\n\n## Goals\n");
  assert.equal(blankBoard("tasks/interview-synthesis.md"), "# Interview synthesis\n\n## Tasks\n");
  assert.deepEqual(listItems(blankBoard("tasks/x.md")), []);
  assert.throws(() => blankBoard("notes.md"), /not a PI, sprint or task board/);
});

test("agents may only name new boards tasks/<lowercase-dashes>.md", () => {
  for (const ok of ["tasks/a.md", "tasks/export-flow.md", "tasks/2-up.md"]) assert.ok(NEW_BOARD_RE.test(ok), ok);
  for (const bad of ["pi.md", "sprint.md", "tasks/A.md", "tasks/a b.md", "tasks/.md", "tasks/-a.md", "tasks/a/b.md", "tasks/../x.md", "tasks/a.txt"]) {
    assert.ok(!NEW_BOARD_RE.test(bad), bad);
  }
});

test("a vault with only pi.md gets sprint.md and tasks/, and nothing existing is touched", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-seed-"));
  const vault = openVault(root);
  await mkdir(join(root, "boards"), { recursive: true });
  await writeFile(vault.boardPath("pi.md"), "# My quarter\n\n## Goals\n- PI-1 [active] Mine | creator: user\n");
  assert.deepEqual(await ensureBoardFiles(vault), ["sprint.md"]);
  assert.equal(await readFile(vault.boardPath("sprint.md"), "utf8"), "# Sprint board\n\n## Goals\n");
  assert.match(await readFile(vault.boardPath("pi.md"), "utf8"), /Mine/);
  assert.ok((await stat(join(root, "boards", "tasks"))).isDirectory());
  assert.deepEqual(await ensureBoardFiles(vault), []);
  assert.deepEqual(checkHierarchy(await loadBoards(vault)), []);
  assert.equal(levelOfBoard("sprint.md"), "sprint");
});

test("a vault with no boards folder at all gets all of it", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-seed-"));
  assert.deepEqual(await ensureBoardFiles(openVault(root)), ["pi.md", "sprint.md"]);
});
