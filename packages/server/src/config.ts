import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type AppConfig = {
  aws: { profile: string; region: string };
  models: { router: string; specialist: string };
  /** Where your real boards, notes and transcripts live. Outside the repo. */
  vaultPath: string;
  userName: string;
  dailyTokenLimit: number;
  port: number;
  defaultBoard: string;
  prices?: { inputPerMTok: number; outputPerMTok: number };
};

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

export function parseConfig(raw: unknown, home: string = homedir()): AppConfig {
  const c = obj(raw);
  const aws = obj(c.aws);
  const models = obj(c.models);
  const prices = c.prices === undefined ? undefined : obj(c.prices);
  const config: AppConfig = {
    aws: { profile: str(aws.profile, "aws.profile"), region: str(aws.region, "aws.region", "us-east-1") },
    models: {
      router: str(models.router, "models.router"),
      specialist: str(models.specialist, "models.specialist"),
    },
    vaultPath: resolve(expandHome(str(c.vaultPath, "vaultPath", "~/agent-manager-vault"), home)),
    userName: str(c.userName, "userName", "You"),
    dailyTokenLimit: num(c.dailyTokenLimit, "dailyTokenLimit", 200_000, { int: true, min: 1 }),
    port: num(c.port, "port", DEFAULT_PORT, { int: true, min: 1, max: 65535 }),
    defaultBoard: str(c.defaultBoard, "defaultBoard", "pi.md"),
  };
  if (prices) {
    config.prices = {
      inputPerMTok: num(prices.inputPerMTok, "prices.inputPerMTok", 0, { min: 0 }),
      outputPerMTok: num(prices.outputPerMTok, "prices.outputPerMTok", 0, { min: 0 }),
    };
  }
  return config;
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
