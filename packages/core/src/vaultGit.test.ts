import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createVaultGit } from "./vaultGit.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function vault() {
  const root = await mkdtemp(join(tmpdir(), "am-git-"));
  return { root, vg: createVaultGit(root) };
}

test("ensureRepo creates a main-branch repo and is safe to call twice", async () => {
  const { root, vg } = await vault();
  await vg.ensureRepo();
  await vg.ensureRepo();
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "main");
});

test("commit records changes and returns a short hash", async () => {
  const { root, vg } = await vault();
  await vg.ensureRepo();
  await mkdir(join(root, "rooms"), { recursive: true });
  await writeFile(join(root, "rooms", "main.jsonl"), '{"hello":1}\n');
  const hash = await vg.commit('Room: "How do we start?" (research-lead)');
  assert.match(hash ?? "", /^[0-9a-f]{7,}$/);
  assert.equal(git(root, "log", "-1", "--format=%s"), 'Room: "How do we start?" (research-lead)');
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("nothing to commit returns null and makes no empty commit", async () => {
  const { root, vg } = await vault();
  await vg.ensureRepo();
  await writeFile(join(root, "a.md"), "x\n");
  await vg.commit("first");
  assert.equal(await vg.commit("second"), null);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
});

test("commits work without any configured git identity", async () => {
  const { root, vg } = await vault();
  const savedHome = process.env.HOME;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  // Point git at an empty global config so no user.name/email exists.
  const empty = join(root, "..", `empty-gitconfig-${Date.now()}`);
  await writeFile(empty, "");
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    await vg.ensureRepo();
    await writeFile(join(root, "a.md"), "x\n");
    assert.ok(await vg.commit("no identity"));
    assert.equal(git(root, "log", "-1", "--format=%an"), "Agent Manager");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
  }
});

test("overlapping commits are serialized and none is lost", async () => {
  const { root, vg } = await vault();
  await vg.ensureRepo();
  const results = await Promise.all(
    [1, 2, 3, 4].map(async (n) => {
      await writeFile(join(root, `f${n}.md`), `${n}\n`);
      return vg.commit(`commit ${n}`);
    }),
  );
  assert.ok(results.some((r) => r !== null));
  assert.equal(git(root, "status", "--porcelain"), "");
  // Every file ended up in history.
  const tracked = git(root, "ls-files").split("\n").sort();
  assert.deepEqual(tracked, ["f1.md", "f2.md", "f3.md", "f4.md"]);
});
