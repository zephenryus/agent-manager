import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertReadableFolder } from "@am/core";

export type OllamaConfig = {
  baseUrl: string;
  models: { router: string; specialist: string };
  numCtx: number;
  think?: boolean;
  keepAlive?: string;
};

type CommonConfig = {
  /** Where your real boards, notes and transcripts live. Outside the repo. */
  vaultPath: string;
  userName: string;
  /** Tokens per day, or null for no limit (the default for a free local model). */
  dailyTokenLimit: number | null;
  port: number;
  defaultBoard: string;
  /** Vault folders agents may read (read-only). */
  readableFolders: string[];
  prices?: { inputPerMTok: number; outputPerMTok: number };
};

/** Which backend serves the models. "bedrock" (the default) or "ollama" for a local model. */
export type AppConfig = CommonConfig &
  (
    | { provider: "bedrock"; aws: { profile: string; region: string }; models: { router: string; specialist: string } }
    | { provider: "ollama"; ollama: OllamaConfig }
  );

export const DEFAULT_PORT = 4317;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function str(v: unknown, field: string, fallback?: string): string {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`config: "${field}" must be a non-empty string`);
  return v;
}

function num(v: unknown, field: string, fallback: number, opts: { int?: boolean; min?: number; max?: number } = {}): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`config: "${field}" must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new ConfigError(`config: "${field}" must be a whole number`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`config: "${field}" must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(`config: "${field}" must be at most ${opts.max}`);
  return v;
}

/** Expand a leading ~ so the same config works on the Mac and the PC. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

function parseReadableFolders(v: unknown): string[] {
  if (v === undefined) return ["Interviews"];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`config: "readableFolders" must be a list of folder names, like ["Interviews"]`);
  }
  for (const name of v as string[]) {
    try {
      assertReadableFolder(name);
    } catch (err) {
      throw new ConfigError(`config: "readableFolders": ${(err as Error).message}`);
    }
  }
  return v as string[];
}

function parseOllama(raw: unknown): OllamaConfig {
  const o = obj(raw);
  const models = obj(o.models);
  const baseUrl = str(o.baseUrl, "ollama.baseUrl", "http://127.0.0.1:11434");
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http");
  } catch {
    throw new ConfigError(`config: "ollama.baseUrl" must be a web address like http://127.0.0.1:11434`);
  }
  if (o.think !== undefined && typeof o.think !== "boolean") throw new ConfigError(`config: "ollama.think" must be true or false`);
  const result: OllamaConfig = {
    baseUrl,
    models: { router: str(models.router, "ollama.models.router"), specialist: str(models.specialist, "ollama.models.specialist") },
    numCtx: num(o.numCtx, "ollama.numCtx", 16_384, { int: true, min: 2048 }),
  };
  if (typeof o.think === "boolean") result.think = o.think;
  if (o.keepAlive !== undefined) result.keepAlive = str(o.keepAlive, "ollama.keepAlive");
  return result;
}

/**
 * A limit only matters when tokens cost money. Left out, it is 200,000 a day for a cloud provider and no limit
 * for a local one. null means no limit; usage is still counted and shown.
 */
function parseDailyLimit(v: unknown, provider: "bedrock" | "ollama"): number | null {
  if (v === undefined) return provider === "ollama" ? null : 200_000;
  if (v === null) return null;
  try {
    return num(v, "dailyTokenLimit", 0, { int: true, min: 1 });
  } catch (err) {
    throw new ConfigError(`${(err as Error).message} (or null for no limit)`);
  }
}

export function parseConfig(raw: unknown, home: string = homedir()): AppConfig {
  const c = obj(raw);
  const prices = c.prices === undefined ? undefined : obj(c.prices);
  const provider = c.provider === undefined ? "bedrock" : c.provider;
  if (provider !== "bedrock" && provider !== "ollama") {
    throw new ConfigError(`config: "provider" must be "bedrock" or "ollama"`);
  }
  const common: CommonConfig = {
    vaultPath: resolve(expandHome(str(c.vaultPath, "vaultPath", "~/agent-manager-vault"), home)),
    userName: str(c.userName, "userName", "You"),
    dailyTokenLimit: parseDailyLimit(c.dailyTokenLimit, provider),
    port: num(c.port, "port", DEFAULT_PORT, { int: true, min: 1, max: 65535 }),
    defaultBoard: str(c.defaultBoard, "defaultBoard", "pi.md"),
    readableFolders: parseReadableFolders(c.readableFolders),
  };
  if (prices) {
    common.prices = {
      inputPerMTok: num(prices.inputPerMTok, "prices.inputPerMTok", 0, { min: 0 }),
      outputPerMTok: num(prices.outputPerMTok, "prices.outputPerMTok", 0, { min: 0 }),
    };
  }
  if (provider === "ollama") return { ...common, provider, ollama: parseOllama(c.ollama) };
  const aws = obj(c.aws);
  const models = obj(c.models);
  return {
    ...common,
    provider,
    aws: { profile: str(aws.profile, "aws.profile"), region: str(aws.region, "aws.region", "us-east-1") },
    models: { router: str(models.router, "models.router"), specialist: str(models.specialist, "models.specialist") },
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new ConfigError(`No config at ${path}. Copy config.example.json to config.local.json and edit it.`);
    }
    throw err;
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) throw new ConfigError(`${path} is not valid JSON: ${err.message}`);
    throw err;
  }
}
