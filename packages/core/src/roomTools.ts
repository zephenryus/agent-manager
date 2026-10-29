import type { Suggestion } from "./transcript.ts";
import type { Tool } from "./types.ts";

export const MAX_SUGGESTION_MESSAGE = 500;

/**
 * suggest_next lets an agent say "I'd like X's take". Suggestions are collected, shown to the user as
 * clickable chips, and never run automatically. Clicking a chip drafts the suggestion's message in the
 * user's message box; the user reads it and sends it, or not.
 */
export function createSuggestTool(
  selfId: string,
  validIds: string[],
  sink: Suggestion[],
): Tool {
  return {
    name: "suggest_next",
    terminal: true,
    description:
      "OPTIONAL extra, used only AFTER you have fully answered the request in your reply. Suggests that the user " +
      "hear from another teammate next. It never replaces your answer and does not run that teammate; the user " +
      "decides. Write your complete answer in the same message as this call: nothing further is needed after it, " +
      "and the app shows the suggestion for you.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The teammate's id" },
        reason: { type: "string", description: "One short sentence on why" },
        message: {
          type: "string",
          description:
            `The exact message the user could send that teammate, written in the user's own voice ` +
            `(for example "Can you pull three themes from the interview notes?"). Make it self-contained: ` +
            `the teammate may not have seen this chat. At most ${MAX_SUGGESTION_MESSAGE} characters.`,
        },
      },
      required: ["agent_id", "reason"],
    },
    run(input) {
      const { agent_id, reason, message } = input;
      if (typeof agent_id !== "string" || typeof reason !== "string") {
        throw new Error("agent_id and reason must be strings");
      }
      if (message !== undefined && typeof message !== "string") throw new Error("message must be text");
      const draft = typeof message === "string" ? message.trim() : "";
      if (draft.length > MAX_SUGGESTION_MESSAGE) {
        throw new Error(`message is too long (at most ${MAX_SUGGESTION_MESSAGE} characters). Shorten it and call suggest_next again.`);
      }
      if (agent_id === selfId) throw new Error("You cannot suggest yourself");
      if (!validIds.includes(agent_id)) {
        throw new Error(`Unknown teammate "${agent_id}". Valid ids: ${validIds.join(", ")}`);
      }
      if (!sink.some((s) => s.agentId === agent_id)) {
        sink.push({ agentId: agent_id, reason, ...(draft !== "" ? { message: draft } : {}) });
      }
      return `Suggested ${agent_id}.`;
    },
  };
}
