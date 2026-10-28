import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULT_PORT, expandHome, loadConfig, parseConfig } from "./config.ts";

const minimal = {
  aws: { profile: "work" },
  models: { router: "r-model", specialist: "s-model" },
};

test("defaults fill in everything optional", () => {
  const c = parseConfig(minimal, "/home/kevin");
  assert.equal(c.aws.region, "us-east-1");
  assert.equal(c.port, DEFAULT_PORT);
  assert.equal(c.dailyTokenLimit, 200_000);
  assert.equal(c.userName, "You");
  assert.equal(c.defaultBoard, "pi.md");
  assert.equal(c.vaultPath, resolve("/home/kevin/agent-manager-vault"));
  assert.equal(c.prices, undefined);
});

test("~ expands to the home folder on any platform", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/v", "/h"), join("/h", "v"));
  assert.equal(expandHome("~\\v", "/h"), join("/h", "v"));
  assert.equal(expandHome("/abs/v", "/h"), "/abs/v");
  assert.equal(expandHome("~other/v", "/h"), "~other/v");
});

test("explicit values are used", () => {
  const c = parseConfig(
    { ...minimal, userName: "Kevin", dailyTokenLimit: 50_000, port: 5000, vaultPath: "/data/v", prices: { inputPerMTok: 3, outputPerMTok: 15 } },
    "/h",
  );
  assert.equal(c.userName, "Kevin");
  assert.equal(c.dailyTokenLimit, 50_000);
  assert.equal(c.port, 5000);
  assert.equal(c.vaultPath, resolve("/data/v"));
  assert.deepEqual(c.prices, { inputPerMTok: 3, outputPerMTok: 15 });
});

test("mistakes name the field", () => {
  const bad = (patch: object, re: RegExp) => assert.throws(() => parseConfig({ ...minimal, ...patch }), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ dailyTokenLimit: 0 }, /dailyTokenLimit.*at least 1/);
  bad({ dailyTokenLimit: "lots" }, /dailyTokenLimit.*number/);
  bad({ dailyTokenLimit: 1.5 }, /dailyTokenLimit.*whole number/);
  bad({ port: 70000 }, /port.*at most 65535/);
  bad({ userName: "" }, /userName/);
  assert.throws(() => parseConfig({ models: minimal.models }), /aws\.profile/);
  assert.throws(() => parseConfig({ aws: minimal.aws }), /models\.router/);
  assert.throws(() => parseConfig(null), /aws\.profile/);
});

test("loadConfig: missing file explains what to do; bad JSON says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-cfg-"));
  await assert.rejects(() => loadConfig(join(dir, "nope.json")), /Copy config\.example\.json to config\.local\.json/);
  await writeFile(join(dir, "bad.json"), "{ nope");
  await assert.rejects(() => loadConfig(join(dir, "bad.json")), /not valid JSON/);
  await writeFile(join(dir, "ok.json"), JSON.stringify(minimal));
  assert.equal((await loadConfig(join(dir, "ok.json"))).aws.profile, "work");
});
