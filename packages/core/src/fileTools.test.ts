import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertReadableFolder, createFileTools, MAX_READ_CHARS, MAX_READ_LINES } from "./fileTools.ts";
import { openVault } from "./vault.ts";

async function setup(folders = ["Interviews"]) {
  const root = await mkdtemp(join(tmpdir(), "am-files-"));
  await mkdir(join(root, "Interviews", "extra"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents", "floor-manager.md"), "SECRET CHARTER");
  await writeFile(join(root, "Interviews", "a.md"), ["# A", "line two", "line three", "line four", "line five"].join("\n") + "\n");
  await writeFile(join(root, "Interviews", "crlf.txt"), "one\r\ntwo\r\nthree");
  await writeFile(join(root, "Interviews", "extra", "b.csv"), "x,y\n1,2\n");
  await writeFile(join(root, "Interviews", "photo.png"), "not really");
  await writeFile(join(root, "Interviews", "empty.md"), "");
  await writeFile(join(root, "Interviews", ".hidden.md"), "hidden");
  const tools = createFileTools({ vault: openVault(root), folders });
  const run = async (name: string, input: Record<string, unknown>): Promise<string> => tools.find((t) => t.name === name)!.run(input);
  return { root, run };
}

test("files_list shows readable files with sizes, skips other types and hidden files", async () => {
  const { run } = await setup();
  const all = (await run("files_list", {})).split("\n");
  assert.deepEqual(all.map((l) => l.replace(/ \(.*\)$/, "")), [
    "Interviews/a.md",
    "Interviews/crlf.txt",
    "Interviews/empty.md",
    "Interviews/extra/b.csv",
  ]);
  assert.match(all[0]!, /\(\d+ B\)$/);
  assert.deepEqual((await run("files_list", { folder: "Interviews/extra" })).split("\n").map((l) => l.replace(/ \(.*\)$/, "")), ["Interviews/extra/b.csv"]);
});

test("a missing allowed folder lists as empty instead of failing", async () => {
  const { run } = await setup(["Interviews", "artifacts"]);
  assert.match(await run("files_list", {}), /Interviews\/a\.md/);
  await assert.rejects(() => run("files_list", { folder: "artifacts" }), /Nothing at "artifacts"/);
  const empty = await setup(["artifacts"]);
  assert.equal(await empty.run("files_list", {}), "No readable files found.");
});

test("files_read returns a window with a header that says where to continue", async () => {
  const { run } = await setup();
  assert.equal(await run("files_read", { path: "Interviews/a.md", lines: 2 }), "Interviews/a.md, lines 1-2 of 5; continue with from_line 3\n---\n# A\nline two");
  assert.equal(
    await run("files_read", { path: "Interviews/a.md", from_line: 4, lines: 10 }),
    "Interviews/a.md, lines 4-5 of 5 (end of file)\n---\nline four\nline five",
  );
  assert.equal(await run("files_read", { path: "Interviews/crlf.txt" }), "Interviews/crlf.txt, lines 1-3 of 3 (end of file)\n---\none\ntwo\nthree");
  assert.equal(await run("files_read", { path: "Interviews\\extra\\b.csv" }), "Interviews/extra/b.csv, lines 1-2 of 2 (end of file)\n---\nx,y\n1,2");
  assert.equal(await run("files_read", { path: "Interviews/empty.md" }), "Interviews/empty.md is empty.");
});

test("reads are capped by lines and by characters", async () => {
  const { root, run } = await setup();
  await writeFile(join(root, "Interviews", "long.md"), Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join("\n"));
  const capped = await run("files_read", { path: "Interviews/long.md", lines: 5000 });
  assert.match(capped, new RegExp(`lines 1-${MAX_READ_LINES} of 1000; continue with from_line ${MAX_READ_LINES + 1}`));
  await writeFile(join(root, "Interviews", "wide.md"), Array.from({ length: 50 }, () => "x".repeat(1000)).join("\n"));
  const wide = await run("files_read", { path: "Interviews/wide.md" });
  assert.ok(wide.length < MAX_READ_CHARS + 200);
  assert.match(wide, /lines 1-1[01] of 50; continue with from_line 1[12]/);
});

test("bad ranges and bad files are readable errors", async () => {
  const { root, run } = await setup();
  await assert.rejects(() => run("files_read", { path: "Interviews/a.md", from_line: 99 }), /has only 5 lines/);
  await assert.rejects(() => run("files_read", { path: "Interviews/a.md", from_line: 0 }), /from_line must be a whole number/);
  await assert.rejects(() => run("files_read", { path: "Interviews/a.md", lines: 1.5 }), /lines must be a whole number/);
  await assert.rejects(() => run("files_read", { path: "Interviews/photo.png" }), /Only .*files can be read/);
  await assert.rejects(() => run("files_read", { path: "Interviews/extra" }), /is a folder/);
  await assert.rejects(() => run("files_read", { path: "Interviews/nope.md" }), /Nothing at/);
  await assert.rejects(() => run("files_read", {}), /Give a path/);
  await writeFile(join(root, "Interviews", "bin.txt"), "ab\u0000cd");
  await assert.rejects(() => run("files_read", { path: "Interviews/bin.txt" }), /not a text file/);
  await assert.rejects(() => run("files_list", { folder: "Interviews/a.md" }), /is a file, not a folder/);
});

test("nothing outside the allowed folders can be read", async () => {
  const { root, run } = await setup();
  for (const path of [
    "agents/floor-manager.md",
    "../agents/floor-manager.md",
    "Interviews/../agents/floor-manager.md",
    "Interviews/../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "Interviews/.hidden.md",
    "interviews/a.md",
    "Interviews//a.md",
    "",
  ]) {
    await assert.rejects(() => run("files_read", { path }), /allowed folders|Give a path|only read inside|Nothing at|not a path/, path);
  }
  await assert.rejects(() => run("files_list", { folder: "agents" }), /only read inside/);
  assert.ok(!(await run("files_list", {})).includes("SECRET"));
  void root;
});

test("a link inside an allowed folder cannot lead out of it", async (t) => {
  const { root, run } = await setup();
  try {
    await symlink(join(root, "agents"), join(root, "Interviews", "out"), "dir");
    await symlink(join(root, "agents", "floor-manager.md"), join(root, "Interviews", "leak.md"), "file");
  } catch {
    t.skip("this system does not allow creating links without extra rights");
    return;
  }
  await assert.rejects(() => run("files_read", { path: "Interviews/leak.md" }), /not inside the allowed folders/);
  await assert.rejects(() => run("files_read", { path: "Interviews/out/floor-manager.md" }), /not inside the allowed folders/);
  assert.ok(!(await run("files_list", {})).includes("floor-manager"));
});

test("app-owned folders and odd folder names can never be made readable", () => {
  for (const bad of ["agents", "Agents", "notes", "rooms", "usage", "approvals", "boards", "", ".git", "..", "a/b", "a\\b"]) {
    assert.throws(() => assertReadableFolder(bad), /Readable folder|cannot be made readable/, bad);
  }
  assert.doesNotThrow(() => assertReadableFolder("Interviews"));
  assert.throws(() => createFileTools({ vault: openVault(tmpdir()), folders: ["agents"] }), /cannot be made readable/);
});
