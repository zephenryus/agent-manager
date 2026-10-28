import type { Suggestion } from "./transcript.ts";
import type { Tool } from "./types.ts";

/**
 * suggest_next lets an agent say "I'd like X's take". Suggestions are collected, shown to the user as
 * clickable chips, and never run automatically.
 */
export function createSuggestTool(
  selfId: string,
  validIds: string[],
  sink: Suggestion[],
): Tool {
  return {
    name: "suggest_next",
    description:
      "Suggest that the user hear from another teammate next. Use it when someone else's expertise would help. " +
      "This does not run that teammate; the user decides.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The teammate's id" },
        reason: { type: "string", description: "One short sentence on why" },
      },
      required: ["agent_id", "reason"],
    },
    run(input) {
      const { agent_id, reason } = input;
      if (typeof agent_id !== "string" || typeof reason !== "string") {
        throw new Error("agent_id and reason must be strings");
      }
      if (agent_id === selfId) throw new Error("You cannot suggest yourself");
      if (!validIds.includes(agent_id)) {
        throw new Error(`Unknown teammate "${agent_id}". Valid ids: ${validIds.join(", ")}`);
      }
      if (!sink.some((s) => s.agentId === agent_id)) sink.push({ agentId: agent_id, reason });
      return `Suggested ${agent_id}.`;
    },
  };
}
