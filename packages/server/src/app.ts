import { readFile, readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import {
  BudgetError,
  ProviderAuthError,
  createRoom,
  readTail,
} from "@am/core";
import type {
  AgentDef,
  AgentState,
  Budget,
  BudgetSnapshot,
  ModelTier,
  Provider,
  Room,
  RoomEvent,
  Router,
  Vault,
  VaultGit,
} from "@am/core";

export type AppOptions = {
  vault: Vault;
  agents: AgentDef[];
  providers: Record<ModelTier, Provider>;
  router: Router;
  budget: Budget;
  /** Omit to skip version history (for example when git is not installed). */
  git?: Pick<VaultGit, "commit">;
  userName: string;
  defaultBoard: string;
  /** Folder with index.html, style.css, app.js ... served at /. */
  publicDir: string;
  /** Host names the browser may use, with port (DNS-rebinding guard). */
  allowedHosts: string[];
  /** Shown in the UI so it is obvious nothing real is being called. */
  demo?: boolean;
  log?: (line: string) => void;
};

export type App = {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Close open event streams (call before closing the HTTP server). */
  close(): void;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MAX_BODY = 64 * 1024;

export function createApp(opts: AppOptions): App {
  const log = opts.log ?? (() => undefined);
  const agentStates = new Map<string, AgentState>(opts.agents.map((a) => [a.id, "idle"]));
  const clients = new Set<ServerResponse>();
  const activeAgents = opts.agents.filter((a) => a.status === "active");
  let busy = false;

  const writeEvent = (res: ServerResponse, event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) writeEvent(res, event, data);
  };

  const room: Room = createRoom({
    vault: opts.vault,
    agents: opts.agents,
    providers: opts.providers,
    router: opts.router,
    userName: opts.userName,
    defaultBoard: opts.defaultBoard,
    onEvent: (e: RoomEvent) => {
      if (e.type === "agent_state") agentStates.set(e.agentId, e.state);
      // Raw model internals stay on the server; the UI only needs what a person would see.
      if (e.type === "turn") {
        if (e.event.type === "tool_call") broadcast("room", { type: "tool", agentId: e.agentId, name: e.event.name });
        return;
      }
      broadcast("room", e);
    },
  });

  opts.budget.subscribe((s) => broadcast("budget", s));

  const keepalive = setInterval(() => {
    for (const res of clients) res.write(": keepalive\n\n");
  }, 15_000);
  keepalive.unref();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  const rosterView = () =>
    opts.agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      avatar: a.avatar,
      accent: a.accent,
      status: a.status,
      isOrchestrator: a.isOrchestrator,
      reportsTo: a.reportsTo,
      state: agentStates.get(a.id) ?? "idle",
    }));

  async function listBoards(): Promise<string[]> {
    try {
      const names = await readdir(join(opts.vault.root, "boards"));
      return names.filter((n) => n.endsWith(".md")).sort();
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
  }

  function checkHost(req: IncomingMessage) {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!opts.allowedHosts.includes(host)) throw new HttpError(403, "Host not allowed");
  }

  function checkOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin === undefined) return; // not a browser (curl, tests)
    let host: string;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      throw new HttpError(403, "Bad origin");
    }
    if (!opts.allowedHosts.includes(host)) throw new HttpError(403, "Cross-site request refused");
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "Send JSON (content-type: application/json)");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY) throw new HttpError(413, "Message too large");
      chunks.push(buf);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Body is not valid JSON");
    }
  }

  function channelFile(channel: string): string {
    if (channel === "room") return opts.vault.roomFile;
    if (channel.startsWith("dm:")) {
      const id = channel.slice(3);
      if (!activeAgents.some((a) => a.id === id)) throw new HttpError(404, `No agent "${id}"`);
      return opts.vault.dmFile(id);
    }
    throw new HttpError(400, 'channel must be "room" or "dm:<agent id>"');
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const root = resolve(opts.publicDir);
    const target = resolve(root, "." + decodeURIComponent(rel));
    if (target !== root && !target.startsWith(root + sep)) throw new HttpError(404, "Not found");
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new HttpError(404, "Not found");
      const body = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-cache",
        "content-length": body.length,
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as { code?: string }).code === "ENOENT") throw new HttpError(404, "Not found");
      throw err;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    checkHost(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (url.pathname === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      res.on("close", () => clients.delete(res));
      writeEvent(res, "hello", { busy });
      return;
    }

    if (url.pathname === "/api/state" && method === "GET") {
      json(res, 200, {
        userName: opts.userName,
        demo: opts.demo === true,
        agents: rosterView(),
        boards: await listBoards(),
        defaultBoard: opts.defaultBoard,
        budget: await opts.budget.snapshot(),
        busy,
        history: opts.git !== undefined,
      });
      return;
    }

    if (url.pathname === "/api/transcript" && method === "GET") {
      const file = channelFile(url.searchParams.get("channel") ?? "room");
      const asked = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 500) : 100;
      json(res, 200, { entries: await readTail(file, limit) });
      return;
    }

    if (url.pathname === "/api/board" && method === "GET") {
      const name = url.searchParams.get("name") ?? opts.defaultBoard;
      let path: string;
      try {
        path = opts.vault.boardPath(name);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      try {
        json(res, 200, { name, text: await readFile(path, "utf8") });
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") throw new HttpError(404, `No board named "${name}"`);
        throw err;
      }
      return;
    }

    if (url.pathname === "/api/send" && method === "POST") {
      checkOrigin(req);
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text === "") throw new HttpError(400, "Write a message first");
      if (body.dm !== undefined && typeof body.dm !== "string") throw new HttpError(400, "dm must be an agent id");
      if (body.focus !== undefined && typeof body.focus !== "string") throw new HttpError(400, "focus must be a board name");
      if (typeof body.dm === "string" && !activeAgents.some((a) => a.id === body.dm)) {
        throw new HttpError(400, `No active agent "${body.dm}" to chat with`);
      }
      if (typeof body.focus === "string") {
        try {
          opts.vault.boardPath(body.focus);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      if (busy) throw new HttpError(409, "The team is still working on the last message");

      busy = true;
      broadcast("busy", { busy: true });
      try {
        const result = await room.send(text, {
          ...(typeof body.dm === "string" ? { dm: body.dm } : {}),
          ...(typeof body.focus === "string" ? { focus: body.focus } : {}),
        });
        let saved: string | null = null;
        if (opts.git) {
          try {
            const who = result.replies.map((r) => r.from).join(", ");
            const short = text.replace(/\s+/g, " ").slice(0, 60);
            saved = await opts.git.commit(`${body.dm ? "DM" : "Room"}: "${short}" (${who})`);
          } catch (err) {
            log(`history: could not save a commit: ${(err as Error).message}`);
          }
        }
        json(res, 200, {
          ok: true,
          replies: result.replies.map((r) => r.id),
          suggestions: result.suggestions,
          usage: result.usage,
          saved,
        });
      } finally {
        busy = false;
        broadcast("busy", { busy: false });
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
    await serveStatic(url.pathname, res);
  }

  return {
    handle(req, res) {
      route(req, res).catch((err: unknown) => {
        let status = 500;
        let body: Record<string, unknown> = { error: "Something went wrong on the server." };
        if (err instanceof HttpError) {
          status = err.status;
          body = { error: err.message, ...err.extra };
        } else if (err instanceof ProviderAuthError) {
          status = 401;
          body = { error: err.message, hint: err.hint, kind: "auth" };
        } else if (err instanceof BudgetError) {
          status = 429;
          body = { error: err.message, kind: "budget", budget: err.snapshot satisfies BudgetSnapshot };
        } else {
          log(`error: ${(err as Error).stack ?? String(err)}`);
        }
        if (res.headersSent) {
          res.end();
          return;
        }
        json(res, status, body);
      });
    },
    close() {
      clearInterval(keepalive);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
