import { readFile } from "node:fs/promises";
import { createBoardWriteTools } from "./boardWriteTools.ts";
import { createFileTools } from "./fileTools.ts";
import { buildContext } from "./context.ts";
import type { FocusBoard } from "./context.ts";
import { listBoardNames } from "./hierarchy.ts";
import { createNotes } from "./notes.ts";
import { createNotesTools } from "./notesTools.ts";
import { WORKSPACES_DIR, createWorkspaceTools } from "./workspaces.ts";
import { createSuggestTool } from "./roomTools.ts";
import { isQuietTool, summarizeError, summarizeToolCall } from "./toolActivity.ts";
import type { ToolActivity } from "./toolActivity.ts";
import { findMentions } from "./router.ts";
import type { RouteDecision, Router } from "./router.ts";
import { LOGGED_TOOLS, autoLogText, createWorklog, createWorklogTools } from "./worklog.ts";
import type { Worklog } from "./worklog.ts";
import { appendEntry, readTail, systemClock } from "./transcript.ts";
import type { Clock, Suggestion, TranscriptEntry } from "./transcript.ts";
import { runTurn } from "./turn.ts";
import type { TurnEvent } from "./turn.ts";
import type { Provider, Tool, Usage } from "./types.ts";
import type { AgentDef, ModelTier } from "./agents.ts";
import type { Vault } from "./vault.ts";

/** Tool names an agent file may list in `tools:`. */
export const KNOWN_TOOLS = [
  "board_list",
  "board_add",
  "board_edit",
  "board_set_status",
  "files_list",
  "files_read",
  "files_write",
  "notes_head",
  "notes_tail",
  "notes_append",
  "notes_pin",
  "worklog_add",
  "worklog_read",
  "suggest_next",
] as const;

export type AgentState = "idle" | "thinking" | "working";

/** Everything a UI needs, as it happens. The server forwards these over a WebSocket. */
export type RoomEvent =
  | { type: "entry"; channel: string; entry: TranscriptEntry }
  | { type: "routing"; decision: RouteDecision }
  | { type: "agent_state"; agentId: string; state: AgentState }
  | { type: "turn"; agentId: string; event: TurnEvent };

export type RoomOptions = {
  vault: Vault;
  agents: AgentDef[];
  /** Which provider serves which model tier. */
  providers: Record<ModelTier, Provider>;
  router: Router;
  userName?: string;
  clock?: Clock;
  /** IANA zone agents are told the time in (default: this computer's). */
  timeZone?: string;
  onEvent?: (e: RoomEvent) => void;
  /** Vault folders agents with the files_* tools may read (read-only), for example ["Interviews"]. The workspaces folder is always readable. */
  readableFolders?: string[];
  /** Board (inside <vault>/boards) shown to agents when the user has not chosen a focus. */
  defaultBoard?: string;
  maxSteps?: number;
  /** How many recent transcript entries each agent sees. */
  transcriptWindow?: number;
  pinnedLines?: number;
  logLines?: number;
};

export type SendOptions = {
  /** Private chat with this agent id (skips routing). */
  dm?: string;
  /** Board file (relative to <vault>/boards) to put in front of the agents. */
  focus?: string;
};

export type SendResult = {
  userEntry: TranscriptEntry;
  decision: RouteDecision | null;
  replies: TranscriptEntry[];
  /** Router and agent suggestions, merged. Never includes agents who already replied. */
  suggestions: Suggestion[];
  /** Total tokens for the whole message: routing plus every reply. */
  usage: Usage;
};

const MAX_MENTIONS = 4;

export type Room = { send(text: string, opts?: SendOptions): Promise<SendResult> };

export function createRoom(opts: RoomOptions): Room {
  const clock = opts.clock ?? systemClock;
  const worklog = createWorklog(opts.vault, clock, opts.timeZone);
  const emit = (e: RoomEvent) => opts.onEvent?.(e);
  const windowSize = opts.transcriptWindow ?? 20;
  const active = opts.agents.filter((a) => a.status === "active");
  const byId = new Map(active.map((a) => [a.id, a]));
  // Workspaces are always readable: whatever an agent saves with files_write, everyone can read back.
  const readable = [...new Set([...(opts.readableFolders ?? []), WORKSPACES_DIR])];
  // Fail at startup, not on the first message, if the folder list names something that must stay private.
  const fileTools = createFileTools({ vault: opts.vault, folders: readable });

  return {
    async send(text, sendOpts = {}) {
      const message = text.trim();
      if (message === "") throw new Error("Message is empty");
      if (sendOpts.dm !== undefined && !byId.has(sendOpts.dm)) {
        throw new Error(`No active agent "${sendOpts.dm}" to chat with`);
      }

      const file = sendOpts.dm !== undefined ? opts.vault.dmFile(sendOpts.dm) : opts.vault.roomFile;
      const channel = sendOpts.dm !== undefined ? `dm:${sendOpts.dm}` : "room";
      const focusName = sendOpts.focus ?? opts.defaultBoard;
      // Validate before anything is written, so a bad focus name cannot leave a half-handled message.
      const focusPath = focusName === undefined ? undefined : opts.vault.boardPath(focusName);

      let recentBefore = await readTail(file, 8);
      // A previous send of this same text failed after it was saved (expired creds, say), so it is the
      // last line and nobody answered it. Reuse it instead of writing a duplicate.
      const last = recentBefore[recentBefore.length - 1];
      const retry = last !== undefined && last.from === "user" && last.text === message;
      let userEntry: TranscriptEntry;
      if (retry) {
        userEntry = last;
        recentBefore = recentBefore.slice(0, -1);
      } else {
        userEntry = await appendEntry(file, { from: "user", text: message }, clock);
        emit({ type: "entry", channel, entry: userEntry });
      }

      let decision: RouteDecision | null = null;
      let responders: string[];
      if (sendOpts.dm !== undefined) {
        responders = [sendOpts.dm];
      } else {
        const mentions = findMentions(message, active).slice(0, MAX_MENTIONS);
        decision =
          mentions.length > 0
            ? {
                responders: mentions,
                suggestions: [],
                reason: "mentioned by the user",
                source: "mention",
                usage: { inputTokens: 0, outputTokens: 0 },
              }
            : await opts.router.route({ text: message, recent: recentBefore });
        responders = decision.responders;
        emit({ type: "routing", decision });
      }

      const total: Usage = { ...(decision?.usage ?? { inputTokens: 0, outputTokens: 0 }) };
      const replies: TranscriptEntry[] = [];
      const collected: Suggestion[] = [...(decision?.suggestions ?? [])];

      for (const id of responders) {
        const agent = byId.get(id)!;
        emit({ type: "agent_state", agentId: id, state: "thinking" });
        try {
          const notes = createNotes(opts.vault, id, () => clock.now());
          const [transcript, pinned, logTail, focus, boards, workLog] = await Promise.all([
            readTail(file, windowSize),
            notes.head(opts.pinnedLines ?? 40),
            notes.tail(opts.logLines ?? 10),
            loadFocus(focusName, focusPath),
            listBoardNames(opts.vault),
            agent.tools.includes("worklog_read") ? worklog.read({ limit: 10 }) : Promise.resolve(undefined),
          ]);
          const ctx = buildContext({
            agent,
            roster: active,
            transcript,
            pinned,
            logTail,
            ...(focus ? { focus } : {}),
            boards,
            readable,
            mode: sendOpts.dm !== undefined ? "dm" : "room",
            now: clock.now(),
            ...(workLog ? { workLog } : {}),
            ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
            ...(opts.userName ? { userName: opts.userName } : {}),
          });

          const sink: Suggestion[] = [];
          const tools = buildTools(agent, {
            notes,
            validIds: active.map((a) => a.id),
            sink,
            vault: opts.vault,
            agents: active,
            clock,
            worklog,
            fileTools,
            ...(focus && focusName !== undefined ? { focusName } : {}),
          });

          const activity: ToolActivity[] = [];
          const changes: string[] = [];
          const calls = new Map<string, { name: string; summary: string }>();
          const result = await runTurn({
            provider: opts.providers[agent.modelTier],
            system: ctx.system,
            messages: ctx.messages,
            tools,
            maxSteps: opts.maxSteps ?? 6,
            maxOutputTokens: agent.tokenCap,
            onEvent: (event) => {
              emit({ type: "turn", agentId: id, event });
              if (event.type === "tool_call") {
                calls.set(event.id, { name: event.name, summary: summarizeToolCall(event.name, event.input) });
                emit({ type: "agent_state", agentId: id, state: "working" });
              } else if (event.type === "tool_result" && !isQuietTool(event.name)) {
                if (!event.isError && LOGGED_TOOLS.includes(event.name)) changes.push(autoLogText(event.output));
                const call = calls.get(event.id);
                activity.push({
                  name: event.name,
                  summary: call?.summary ?? "",
                  ok: !event.isError,
                  ...(event.isError ? { error: summarizeError(event.output) } : {}),
                });
              }
            },
          });

          if (changes.length > 0) {
            // The record of what actually happened, whether or not the agent also wrote its own line.
            await worklog.add({ agent: id, text: changes.join(" "), auto: true }).catch(() => undefined);
          }

          total.inputTokens += result.usage.inputTokens;
          total.outputTokens += result.usage.outputTokens;
          const entry = await appendEntry(
            file,
            {
              from: id,
              text: result.text.trim() === "" ? "(no reply)" : result.text,
              usage: result.usage,
              ...(sink.length > 0 ? { suggestions: sink } : {}),
              ...(activity.length > 0 ? { tools: activity } : {}),
              ...(result.stopped === "max_steps" ? { stopped: "max_steps" as const } : {}),
            },
            clock,
          );
          replies.push(entry);
          collected.push(...sink);
          emit({ type: "entry", channel, entry });
        } finally {
          emit({ type: "agent_state", agentId: id, state: "idle" });
        }
      }

      const replied = new Set(responders);
      const suggestions: Suggestion[] = [];
      for (const s of collected) {
        if (replied.has(s.agentId) || !byId.has(s.agentId)) continue;
        if (!suggestions.some((x) => x.agentId === s.agentId)) suggestions.push(s);
      }
      return { userEntry, decision, replies, suggestions, usage: total };
    },
  };
}

async function loadFocus(name: string | undefined, path: string | undefined): Promise<FocusBoard | undefined> {
  if (name === undefined || path === undefined) return undefined;
  try {
    return { name, text: await readFile(path, "utf8") };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

type ToolDeps = {
  notes: ReturnType<typeof createNotes>;
  validIds: string[];
  sink: Suggestion[];
  vault: Vault;
  agents: AgentDef[];
  clock: Clock;
  fileTools: Tool[];
  focusName?: string;
  worklog: Worklog;
};

/** Give an agent exactly the tools its file lists (and that exist). */
function buildTools(agent: AgentDef, deps: ToolDeps): Tool[] {
  const all: Tool[] = [
    ...createNotesTools(deps.notes),
    createSuggestTool(agent.id, deps.validIds, deps.sink),
    ...deps.fileTools,
    ...createWorkspaceTools({ vault: deps.vault, actor: agent.id }),
    ...createWorklogTools({ worklog: deps.worklog, actor: agent.id }),
    ...createBoardWriteTools({
      vault: deps.vault,
      agents: deps.agents,
      actor: agent.id,
      clock: deps.clock,
      ...(deps.focusName !== undefined ? { defaultBoard: deps.focusName } : {}),
    }),
  ];
  return all.filter((t) => agent.tools.includes(t.name));
}
