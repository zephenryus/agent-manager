import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEFS_DIR, briefFileName, briefTitle, createBriefTools, listBriefs, readBrief } from "./briefs.ts";
import { openVault } from "./vault.ts";

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

function tools(root: string) {
  const [write, read] = createBriefTools({ vault: openVault(root), actor: "floor-manager" });
  return { write: write!, read: read! };
}

test("file names come from the title", () => {
  assert.equal(briefFileName("SP-1"), "sp-1.md");
  assert.equal(briefFileName("  Interview themes & open questions! "), "interview-themes-open-questions.md");
  assert.throws(() => briefFileName("!!!"), /letters or numbers/);
});

test("brief_write builds the page, and writing the same title again updates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  await mkdir(join(root, "boards", "tasks"), { recursive: true });
  await writeFile(join(root, "boards", "tasks", "synthesis.md"), "x");
  const { write, read } = tools(root);
  const out = await write.run({
    title: "SP-1",
    bottom_line: "SP-1 is done.",
    bullets: ["Friction in triage", "Skill gaps"],
    details: ["boards/tasks/synthesis.md", "T-2"],
  });
  assert.equal(out, `Saved brief "SP-1" as ${BRIEFS_DIR}/sp-1.md.`);
  const saved = await readFile(join(root, BRIEFS_DIR, "sp-1.md"), "utf8");
  assert.equal(saved, "# SP-1\n\nSP-1 is done.\n\n- Friction in triage\n- Skill gaps\n\nDetails: boards/tasks/synthesis.md, T-2\n");
  assert.match(String(await write.run({ title: "sp-1", bottom_line: "Still done." })), /^Updated brief/);
  assert.equal((await readFile(join(root, BRIEFS_DIR, "sp-1.md"), "utf8")), "# sp-1\n\nStill done.\n");
  assert.equal(await read.run({ name: "SP-1" }), "# sp-1\n\nStill done.\n");
  assert.equal(await read.run({ name: "sp-1.md" }), "# sp-1\n\nStill done.\n");
});

test("brief_write accepts bullets and details given as text, which small models do", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  const { write } = tools(root);
  await write.run({ title: "Plain", bottom_line: "ok", bullets: "- one\n- two", details: "T-2, T-3" });
  assert.equal(await readFile(join(root, BRIEFS_DIR, "plain.md"), "utf8"), "# Plain\n\nok\n\n- one\n- two\n\nDetails: T-2, T-3\n");
});

test("brief_write refuses paths that do not exist and saves nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  const { write } = tools(root);
  await assert.rejects(async () => write.run({ title: "X", bottom_line: "y", details: ["tasks/made-up.md", "../outside.md", "/etc/passwd"] }), /Not found in the vault: tasks\/made-up\.md, \.\.\/outside\.md, \/etc\/passwd.*Nothing was saved/);
  assert.deepEqual(await listBriefs(root), []);
});

test("brief_write enforces the length limits with messages the agent can act on", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  const { write } = tools(root);
  const base = { title: "T", bottom_line: "b" };
  await assert.rejects(async () => write.run({ bottom_line: "b" }), /title is required/);
  await assert.rejects(async () => write.run({ ...base, bottom_line: "x".repeat(301) }), /bottom_line is 301 characters; keep it under 300/);
  await assert.rejects(async () => write.run({ ...base, bullets: ["a", "b", "c", "d", "e"] }), /at most 4 bullets, not 5/);
  await assert.rejects(async () => write.run({ ...base, bullets: ["x".repeat(161)] }), /keep each under 160/);
  await assert.rejects(async () => write.run({ ...base, details: ["T-1", "T-2", "T-3", "T-4", "T-5", "T-6"] }), /at most 5 details/);
  await assert.rejects(async () => write.run({ ...base, bullets: 5 }), /bullets must be a list of text/);
  await assert.rejects(async () => write.run({ title: 7, bottom_line: "b" }), /title must be text/);
});

test("brief_read lists briefs, and an unknown name says what exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "am-briefs-"));
  const { write, read } = tools(root);
  assert.equal(await read.run({}), "(no briefs yet)");
  await write.run({ title: "Alpha", bottom_line: "a" });
  assert.match(String(await read.run({})), /^alpha\.md: Alpha \(\d{4}-\d\d-\d\d\)$/);
  await assert.rejects(async () => read.run({ name: "beta" }), /No brief named "beta"\. Briefs: alpha\.md/);
});
