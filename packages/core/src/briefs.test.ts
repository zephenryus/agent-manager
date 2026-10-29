import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEFS_DIR, briefTitle, listBriefs, readBrief } from "./briefs.ts";

async function vaultWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  await mkdir(join(root, BRIEFS_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, BRIEFS_DIR, name), text);
  return root;
}

test("title is the first heading, else the file name", () => {
  assert.equal(briefTitle("a.md", "# Pricing call ##\n\nbody"), "Pricing call");
  assert.equal(briefTitle("a-b.md", "no heading here"), "a-b");
  assert.equal(briefTitle("x.md", "---\nk: v\n---\n# After frontmatter"), "x", "frontmatter is not parsed; falls back to the name");
  assert.equal(briefTitle("x.md", "\n\n# Later but still first"), "Later but still first");
});

test("a vault with no briefs folder lists nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  assert.deepEqual(await listBriefs(root), []);
  assert.equal(await readBrief(root, "a.md"), null);
});

test("lists markdown briefs newest first, ignoring other files", async () => {
  const root = await vaultWith({ "old.md": "# Old", "new.md": "# New", "notes.txt": "x", ".hidden.md": "x" });
  await utimes(join(root, BRIEFS_DIR, "old.md"), new Date("2026-01-01"), new Date("2026-01-01"));
  await utimes(join(root, BRIEFS_DIR, "new.md"), new Date("2026-02-01"), new Date("2026-02-01"));
  const list = await listBriefs(root);
  assert.deepEqual(list.map((b) => [b.name, b.title]), [["new.md", "New"], ["old.md", "Old"]]);
  assert.equal(list[0]!.modified, "2026-02-01T00:00:00.000Z");
});

test("reads one brief by plain name only", async () => {
  const root = await vaultWith({ "a.md": "# A\n\nhello" });
  const b = await readBrief(root, "a.md");
  assert.equal(b?.text, "# A\n\nhello");
  assert.equal(b?.title, "A");
  for (const bad of ["../a.md", "sub/a.md", "a.txt", "", "..\\a.md", "/etc/passwd", "missing.md"]) {
    assert.equal(await readBrief(root, bad), null, bad);
  }
});

test("a symlinked brief is not followed", async (t) => {
  const root = await vaultWith({ "real.md": "# Real" });
  const outside = join(await mkdtemp(join(tmpdir(), "am-out-")), "secret.md");
  await writeFile(outside, "# Secret");
  try {
    await symlink(outside, join(root, BRIEFS_DIR, "link.md"));
  } catch {
    t.skip("cannot create symlinks here");
    return;
  }
  assert.deepEqual((await listBriefs(root)).map((b) => b.name), ["real.md"]);
  assert.equal(await readBrief(root, "link.md"), null);
});
