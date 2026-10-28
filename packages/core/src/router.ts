import type { AgentDef } from "./agents.ts";
import type { Suggestion, TranscriptEntry } from "./transcript.ts";
import { ProviderAuthError } from "./types.ts";
import type { Provider, ToolSpec, Usage } from "./types.ts";

export type RouteInput = {
  text: string;
  /** Recent room messages, oldest first, so follow-ups like "and the second one?" route sensibly. */
  recent: TranscriptEntry[];
};

export type RouteDecision = {
  /** Agent ids, in the order they should reply. Never empty. */
  responders: string[];
  suggestions: Suggestion[];
  reason: string;
  source: "mention" | "llm" | "fallback" | "static";
  /** Tokens the routing call itself used (zero for mention/static). */
  usage: Usage;
};

/** The seam. The default implementation is an LLM call; others can be swapped in later. */
export interface Router {
  route(input: RouteInput): Promise<RouteDecision>;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** `@agent-id` mentions that match active agents, unique, in order of appearance. */
export function findMentions(text: string, agents: AgentDef[]): string[] {
  const ids = new Set(agents.filter((a) => a.status === "active").map((a) => a.id));
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s(])@([a-z0-9][a-z0-9-]*)/gi)) {
    const id = (match[1] ?? "").toLowerCase();
    if (ids.has(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

export function createStaticRouter(orchestratorId: string): Router {
  return {
    async route() {
      return {
        responders: [orchestratorId],
        suggestions: [],
        reason: "static router",
        source: "static",
        usage: NO_USAGE,
      };
    },
  };
}

export type LlmRouterOptions = {
  provider: Provider;
  agents: AgentDef[];
  orchestratorId: string;
  /** Most agents allowed to reply to one message. Default 2 (token budget). */
  maxResponders?: number;
  maxOutputTokens?: number;
};

const ROUTE_TOOL: ToolSpec = {
  name: "route",
  description: "Decide which teammate(s) should answer the new message, and who might be worth hearing from next.",
  inputSchema: {
    type: "object",
    properties: {
      responders: {
        type: "array",
        items: { type: "string" },
        description: "Agent ids who should reply now, best first. Usually one.",
      },
      suggestions: {
        type: "array",
        description: "Optional teammates the user might want to hear from afterwards.",
        items: {
          type: "object",
          properties: { agent_id: { type: "string" }, reason: { type: "string" } },
          required: ["agent_id", "reason"],
        },
      },
      reason: { type: "string", description: "One short sentence explaining the choice." },
    },
    required: ["responders", "reason"],
  },
};

export function createLlmRouter(opts: LlmRouterOptions): Router {
  const active = opts.agents.filter((a) => a.status === "active");
  const max = opts.maxResponders ?? 2;

  const roster = active.map((a) => `- ${a.id}: ${a.role}${a.goal ? ` (${a.goal})` : ""}`).join("\n");
  const system =
    `You are the routing desk for a small product team's chat room. For each new message from the user, ` +
    `call the "route" tool exactly once. Do not write any other text.\n\n` +
    `Team:\n${roster}\n\n` +
    `Rules:\n` +
    `- Pick the ONE best agent unless the message clearly needs two perspectives (never more than ${max}).\n` +
    `- Use "${opts.orchestratorId}" for planning, priorities, board or status questions, and anything unclear.\n` +
    `- Use "suggestions" sparingly, only when another teammate would clearly add value afterwards.\n` +
    `- Only use agent ids from the team list.`;

  return {
    async route(input) {
      const recent = input.recent
        .slice(-6)
        .map((e) => `${e.from}: ${e.text.slice(0, 400)}`)
        .join("\n");
      const text =
        (recent ? `Recent messages:\n${recent}\n\n` : "") + `New message from the user:\n${input.text}`;

      try {
        const res = await opts.provider.complete({
          system,
          messages: [{ role: "user", text }],
          tools: [ROUTE_TOOL],
          maxOutputTokens: opts.maxOutputTokens ?? 300,
        });
        const call = res.toolCalls.find((c) => c.name === "route");
        if (!call) {
          return fallback(opts.orchestratorId, "router did not call the route tool", res.usage);
        }
        return normalizeDecision(call.input, active, opts.orchestratorId, max, res.usage);
      } catch (err) {
        if (err instanceof ProviderAuthError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        return fallback(opts.orchestratorId, `router failed: ${message}`, NO_USAGE);
      }
    },
  };
}

function fallback(orchestratorId: string, reason: string, usage: Usage): RouteDecision {
  return { responders: [orchestratorId], suggestions: [], reason, source: "fallback", usage };
}

/** Turn the model's raw tool input into a safe decision: known ids only, capped, never empty. */
export function normalizeDecision(
  raw: Record<string, unknown>,
  agents: AgentDef[],
  orchestratorId: string,
  maxResponders: number,
  usage: Usage,
): RouteDecision {
  const ids = new Set(agents.map((a) => a.id));

  const responders: string[] = [];
  if (Array.isArray(raw.responders)) {
    for (const r of raw.responders) {
      if (typeof r === "string" && ids.has(r) && !responders.includes(r)) responders.push(r);
    }
  }
  const capped = responders.slice(0, Math.max(1, maxResponders));

  const suggestions: Suggestion[] = [];
  if (Array.isArray(raw.suggestions)) {
    for (const s of raw.suggestions) {
      if (typeof s !== "object" || s === null) continue;
      const { agent_id, reason } = s as { agent_id?: unknown; reason?: unknown };
      if (
        typeof agent_id === "string" &&
        ids.has(agent_id) &&
        !capped.includes(agent_id) &&
        !suggestions.some((x) => x.agentId === agent_id)
      ) {
        suggestions.push({ agentId: agent_id, reason: typeof reason === "string" ? reason : "" });
      }
    }
  }

  const reason = typeof raw.reason === "string" ? raw.reason : "";
  if (capped.length === 0) {
    return {
      responders: [orchestratorId],
      suggestions,
      reason: reason || "router named no valid agent",
      source: "fallback",
      usage,
    };
  }
  return { responders: capped, suggestions, reason, source: "llm", usage };
}
