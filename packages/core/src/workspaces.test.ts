import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileTools } from "./fileTools.ts";
import { MAX_WRITE_CHARS, createWorkspaceTools, ensureWorkspaces } from "./workspaces.ts";
import { openVault } from "./vault.ts";

async function setup(actor = "synthesizer") {
  const root = await mkdtemp(join(tmpdir(), "am-ws-"));
  await mkdir(join(root, "Interviews"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents", "floor-manager.md"), "SECRET CHARTER");
  const vault = openVault(root);
  const tools = createWorkspaceTools({ vault, actor });
  const write = async (input: Record<string, unknown>): Promise<string> => tools.find((t) => t.name === "files_write")!.run(input);
  const read = (rel: string) => readFile(join(root, ...rel.split("/")), "utf8");
  return { root, vault, write, read };
}

test("writes a new file in your own workspace and in shared, creating folders", async () => {
  const { write, read, root } = await setup();
  assert.match(await write({ path: "workspaces/synthesizer/draft.md", content: "# Draft\nline" }), /Created workspaces\/synthesizer\/draft\.md \(2 lines/);
  assert.equal(await read("workspaces/synthesizer/draft.md"), "# Draft\nline\n");
  await write({ path: "workspaces/shared/2026-10-28-themes.md", content: "themes\r\nmore\r\n" });
  assert.equal(await read("workspaces/shared/2026-10-28-themes.md"), "themes\nmore\n");
  await write({ path: "workspaces/synthesizer/interviews/notes.txt", content: "x" });
  assert.ok((await stat(join(root, "workspaces", "synthesizer", "interviews"))).isDirectory());
  // Backslashes (a Windows habit) work too.
  await write({ path: "workspaces\\shared\\b.md", content: "b" });
  assert.equal(await read("workspaces/shared/b.md"), "b\n");
});

test("create refuses to overwrite; replace and append are explicit", async () => {
  const { write, read } = await setup();
  await write({ path: "workspaces/shared/a.md", content: "one" });
  await assert.rejects(() => write({ path: "workspaces/shared/a.md", content: "two" }), /already exists.*replace.*append/);
  assert.equal(await read("workspaces/shared/a.md"), "one\n");
  assert.match(await write({ path: "workspaces/shared/a.md", content: "two", mode: "replace" }), /Replaced/);
  assert.equal(await read("workspaces/shared/a.md"), "two\n");
  assert.match(await write({ path: "workspaces/shared/a.md", content: "three", mode: "append" }), /Appended/);
  assert.equal(await read("workspaces/shared/a.md"), "two\nthree\n");
  // Append to a file that does not end with a newline keeps the new text on its own line.
  await write({ path: "workspaces/shared/raw.txt", content: "", mode: "replace" });
  assert.equal(await read("workspaces/shared/raw.txt"), "");
  await write({ path: "workspaces/shared/new.md", content: "made by append", mode: "append" });
  assert.equal(await read("workspaces/shared/new.md"), "made by append\n");
});

test("append starts a new line when the file did not end with one", async () => {
  const { write, read, root } = await setup();
  await mkdir(join(root, "workspaces", "shared"), { recursive: true });
  await writeFile(join(root, "workspaces", "shared", "human.md"), "typed by hand, no newline");
  await write({ path: "workspaces/shared/human.md", content: "agent line", mode: "append" });
  assert.equal(await read("workspaces/shared/human.md"), "typed by hand, no newline\nagent line\n");
});

test("you can write only to your own folder and shared", async () => {
  const { write, root } = await setup("synthesizer");
  for (const path of [
    "workspaces/research-lead/x.md",
    "workspaces/Shared/x.md",
    "Workspaces/shared/x.md",
    "Interviews/x.md",
    "agents/floor-manager.md",
    "boards/pi.md",
    "x.md",
    "workspaces/x.md",
  ]) {
    await assert.rejects(() => write({ path, content: "x" }), /write only inside workspaces\/synthesizer\/|Name a file/, path);
  }
  await assert.rejects(() => stat(join(root, "workspaces", "research-lead")), /ENOENT/);
  await assert.rejects(() => write({ path: "workspaces/synthesizer", content: "x" }), /Name a file/);
});

test("paths that try to escape or are odd are refused", async () => {
  const { write } = await setup();
  const bad: [string, RegExp][] = [
    ["/etc/passwd.md", /absolute path/],
    ["C:\\Users\\kevin\\x.md", /absolute path/],
    ["workspaces/shared/../../agents/floor-manager.md", /not a valid path/],
    ["workspaces/shared/.hidden.md", /not a valid path/],
    ["workspaces/shared//x.md", /not a valid path/],
    ["workspaces/shared/a.exe", /Files must end in/],
    ["workspaces/shared/noext", /Files must end in/],
    ["workspaces/shared/a:b.md", /not an allowed name/],
    ["workspaces/shared/nul.md", /not an allowed name/],
    ["workspaces/shared/name /x.md", /not an allowed name/],
    ["workspaces/shared/a/b/c.md", /Too deep/],
    ["", /Give a path/],
  ];
  for (const [path, message] of bad) await assert.rejects(() => write({ path, content: "x" }), message, path);
  await assert.rejects(() => write({ path: 5, content: "x" }), /Give a path/);
});

test("content and mode are validated", async () => {
  const { write } = await setup();
  await assert.rejects(() => write({ path: "workspaces/shared/a.md", content: "x".repeat(MAX_WRITE_CHARS + 1) }), /too long/);
  await write({ path: "workspaces/shared/big.md", content: "x".repeat(MAX_WRITE_CHARS) });
  await assert.rejects(() => write({ path: "workspaces/shared/a.md", content: "a\u0000b" }), /plain text/);
  await assert.rejects(() => write({ path: "workspaces/shared/a.md", content: 7 }), /must be text/);
  await assert.rejects(() => write({ path: "workspaces/shared/a.md", content: "x", mode: "delete" }), /mode must be/);
});

test("a folder or link in the way cannot redirect a write", async (t) => {
  const { write, root } = await setup();
  await mkdir(join(root, "workspaces", "shared", "taken.md"), { recursive: true });
  await assert.rejects(() => write({ path: "workspaces/shared/taken.md", content: "x", mode: "replace" }), /is a folder, not a file/);
  await writeFile(join(root, "workspaces", "shared", "afile"), "x");
  await assert.rejects(() => write({ path: "workspaces/shared/afile/b.md", content: "x" }), /is a file, not a folder/);
  try {
    await symlink(join(root, "agents"), join(root, "workspaces", "synthesizer"), "dir");
    await symlink(join(root, "agents", "floor-manager.md"), join(root, "workspaces", "shared", "leak.md"), "file");
  } catch {
    t.skip("this system does not allow creating links without extra rights");
    return;
  }
  await assert.rejects(() => write({ path: "workspaces/synthesizer/x.md", content: "pwned" }), /is a link/);
  await assert.rejects(() => write({ path: "workspaces/shared/leak.md", content: "pwned", mode: "replace" }), /is a link/);
  assert.equal(await readFile(join(root, "agents", "floor-manager.md"), "utf8"), "SECRET CHARTER");
});

test("everything saved is readable by other agents with files_read, but not writable by them", async () => {
  const { vault, write } = await setup("synthesizer");
  await write({ path: "workspaces/synthesizer/analysis.md", content: "my private-ish analysis" });
  const reader = createFileTools({ vault, folders: ["workspaces"] });
  const files = await reader.find((t) => t.name === "files_list")!.run({});
  assert.match(files, /workspaces\/synthesizer\/analysis\.md/);
  assert.match(await reader.find((t) => t.name === "files_read")!.run({ path: "workspaces/synthesizer/analysis.md" }), /my private-ish analysis/);
  const other = createWorkspaceTools({ vault, actor: "research-lead" });
  await assert.rejects(async () => other[0]!.run({ path: "workspaces/synthesizer/analysis.md", content: "x", mode: "replace" }), /write only inside workspaces\/research-lead\//);
});

test("ensureWorkspaces creates the shared folder and is safe to repeat", async () => {
  const { vault, root } = await setup();
  await ensureWorkspaces(vault);
  await ensureWorkspaces(vault);
  assert.ok((await stat(join(root, "workspaces", "shared"))).isDirectory());
});

test("an invalid agent id cannot build workspace tools", async () => {
  const { vault } = await setup();
  assert.throws(() => createWorkspaceTools({ vault, actor: "../evil" }), /Invalid id/);
});
