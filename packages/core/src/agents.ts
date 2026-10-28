import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import type { FrontmatterValue } from "./frontmatter.ts";
import { ID_RE } from "./vault.ts";

export const MODEL_TIERS = ["router", "specialist"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type AgentDef = {
  /** From the file name (floor-manager.md -> floor-manager). */
  id: string;
  name: string;
  role: string;
  goal: string;
  avatar: string;
  accent: string;
  modelTier: ModelTier;
  /** Another agent id, or "user" for the top of the chart. */
  reportsTo: string;
  qaPartner?: string;
  tokenCap: number;
  tools: string[];
  isOrchestrator: boolean;
  status: "active" | "retired";
  /** The markdown body: the agent's charter / system prompt. */
  charter: string;
};

export type Issue = { level: "error" | "warning"; agentId?: string; message: string };

export type ParseResult = { agent: AgentDef | null; issues: Issue[] };

const KNOWN_KEYS = new Set([
  "name",
  "role",
  "goal",
  "avatar",
  "accent",
  "model_tier",
  "reports_to",
  "qa_partner",
  "token_cap",
  "tools",
  "is_orchestrator",
  "status",
]);

export function parseAgent(id: string, source: string): ParseResult {
  const issues: Issue[] = [];
  const fail = (message: string) => issues.push({ level: "error", agentId: id, message });
  const warn = (message: string) => issues.push({ level: "warning", agentId: id, message });

  if (!ID_RE.test(id)) fail(`File name "${id}" is not a valid agent id (lowercase letters, digits, dashes)`);

  const doc = parseFrontmatter(source);
  doc.errors.forEach(fail);
  const d = doc.data;

  const str = (key: string, fallback?: string): string => {
    const v = d[key];
    if (v === undefined) {
      if (fallback === undefined) fail(`Missing required field "${key}"`);
      return fallback ?? "";
    }
    if (typeof v !== "string" || v.trim() === "") {
      fail(`Field "${key}" must be non-empty text`);
      return fallback ?? "";
    }
    return v.trim();
  };

  const name = str("name");
  const role = str("role");
  const goal = d.goal === undefined ? "" : str("goal", "");
  const avatar = str("avatar", id);
  const accent = str("accent", "gray");
  const reportsTo = str("reports_to", "user");

  let modelTier: ModelTier = "specialist";
  if (d.model_tier !== undefined) {
    if (typeof d.model_tier === "string" && (MODEL_TIERS as readonly string[]).includes(d.model_tier)) {
      modelTier = d.model_tier as ModelTier;
    } else {
      fail(`Field "model_tier" must be one of: ${MODEL_TIERS.join(", ")}`);
    }
  }

  let tokenCap = 1500;
  if (d.token_cap !== undefined) {
    if (typeof d.token_cap === "number" && Number.isInteger(d.token_cap) && d.token_cap > 0) {
      tokenCap = d.token_cap;
    } else {
      fail(`Field "token_cap" must be a positive whole number`);
    }
  }

  const tools = listField(d, "tools", fail);
  const qaPartner = d.qa_partner === undefined ? undefined : str("qa_partner");

  let isOrchestrator = false;
  if (d.is_orchestrator !== undefined) {
    if (typeof d.is_orchestrator === "boolean") isOrchestrator = d.is_orchestrator;
    else fail(`Field "is_orchestrator" must be true or false`);
  }

  let status: "active" | "retired" = "active";
  if (d.status !== undefined) {
    if (d.status === "active" || d.status === "retired") status = d.status;
    else fail(`Field "status" must be active or retired`);
  }

  for (const key of Object.keys(d)) {
    if (!KNOWN_KEYS.has(key)) warn(`Unknown field "${key}" (ignored)`);
  }
  if (doc.body === "") warn("Charter (the text below the frontmatter) is empty");

  if (issues.some((i) => i.level === "error")) return { agent: null, issues };

  const agent: AgentDef = {
    id,
    name,
    role,
    goal,
    avatar,
    accent,
    modelTier,
    reportsTo,
    tokenCap,
    tools,
    isOrchestrator,
    status,
    charter: doc.body,
    ...(qaPartner === undefined ? {} : { qaPartner }),
  };
  return { agent, issues };
}

function listField(
  d: Record<string, FrontmatterValue>,
  key: string,
  fail: (message: string) => void,
): string[] {
  const v = d[key];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  fail(`Field "${key}" must be a list like [a, b]`);
  return [];
}

export type LoadedRoster = { agents: AgentDef[]; issues: Issue[] };

/** Load every <id>.md in `dir` (files starting with "_" are skipped). Never throws on bad agent files. */
export async function loadAgents(dir: string, knownTools: string[] = []): Promise<LoadedRoster> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("_")).sort();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { agents: [], issues: [{ level: "error", message: `Agents folder not found: ${dir}` }] };
    }
    throw err;
  }
  const agents: AgentDef[] = [];
  const issues: Issue[] = [];
  for (const file of names) {
    const result = parseAgent(file.slice(0, -3), await readFile(join(dir, file), "utf8"));
    issues.push(...result.issues);
    if (result.agent) agents.push(result.agent);
  }
  issues.push(...validateRoster(agents, knownTools));
  return { agents, issues };
}

/** Cross-agent checks: one orchestrator, valid reporting lines, no cycles, known tools. */
export function validateRoster(agents: AgentDef[], knownTools: string[] = []): Issue[] {
  const issues: Issue[] = [];
  const active = agents.filter((a) => a.status === "active");
  const byId = new Map(agents.map((a) => [a.id, a]));

  const orchestrators = active.filter((a) => a.isOrchestrator);
  if (orchestrators.length === 0) {
    issues.push({ level: "error", message: "The roster needs exactly one active orchestrator (is_orchestrator: true)" });
  } else if (orchestrators.length > 1) {
    issues.push({
      level: "error",
      message: `Only one orchestrator is allowed, found: ${orchestrators.map((a) => a.id).join(", ")}`,
    });
  }

  for (const a of agents) {
    if (a.reportsTo !== "user" && !byId.has(a.reportsTo)) {
      issues.push({ level: "error", agentId: a.id, message: `reports_to "${a.reportsTo}" is not an agent` });
    }
    if (a.reportsTo === a.id) {
      issues.push({ level: "error", agentId: a.id, message: "An agent cannot report to itself" });
    }
    if (a.qaPartner !== undefined && !byId.has(a.qaPartner)) {
      issues.push({ level: "warning", agentId: a.id, message: `qa_partner "${a.qaPartner}" is not in the roster yet` });
    }
    for (const tool of a.tools) {
      if (knownTools.length > 0 && !knownTools.includes(tool)) {
        issues.push({ level: "warning", agentId: a.id, message: `Tool "${tool}" is not available yet (ignored)` });
      }
    }
  }

  // Reporting-line cycles: walk up from each agent; a loop never reaches "user".
  for (const a of agents) {
    const seen = new Set<string>([a.id]);
    let cursor = byId.get(a.reportsTo);
    while (cursor) {
      if (seen.has(cursor.id)) {
        issues.push({ level: "error", agentId: a.id, message: `Reporting line loops back through "${cursor.id}"` });
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.reportsTo);
    }
  }
  return issues;
}
