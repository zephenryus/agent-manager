import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  KNOWN_TOOLS,
  ProviderAuthError,
  createBudget,
  createDemoProvider,
  createLlmRouter,
  loadAgents,
  openVault,
  withBudget,
} from "@am/core";
import type { ModelTier, Provider } from "@am/core";
import { createApp } from "./app.ts";

const sample = resolve(fileURLToPath(new URL("../../../sample-vault", import.meta.url)));

type Harness = {
  base: string;
  port: number;
  commits: string[];
  vaultRoot: string;
  close(): Promise<void>;
};

async function start(
  opts: {
    provider?: Provider;
    dailyLimit?: number;
    git?: boolean;
  } = {},
): Promise<Harness> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "am-server-"));
  await cp(join(sample, "agents"), join(vaultRoot, "agents"), { recursive: true });
  await cp(join(sample, "boards"), join(vaultRoot, "boards"), { recursive: true });
  const publicDir = await mkdtemp(join(tmpdir(), "am-public-"));
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>hi</title>");
  await writeFile(join(publicDir, "app.js"), "console.log(1)");
  await mkdir(join(publicDir, "sub"));

  const vault = openVault(vaultRoot);
  const { agents } = await loadAgents(vault.agentsDir, [...KNOWN_TOOLS]);
  const budget = createBudget({ dir: join(vaultRoot, "usage"), dailyLimit: opts.dailyLimit ?? 1_000_000 });
  const base = opts.provider ?? createDemoProvider({ delayMs: 0 });
  const wrapped = withBudget(base, budget);
  const providers: Record<ModelTier, Provider> = { router: wrapped, specialist: wrapped };
  const commits: string[] = [];

  let app: ReturnType<typeof createApp>;
  const server: Server = createServer((req, res) => app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  app = createApp({
    vault,
    agents,
    providers,
    router: createLlmRouter({ provider: wrapped, agents, orchestratorId: "floor-manager" }),
    budget,
    ...(opts.git === false
      ? {}
      : {
          git: {
            commit: async (m: string) => {
              commits.push(m);
              return "abc1234";
            },
          },
        }),
    userName: "Kevin",
    defaultBoard: "pi.md",
    publicDir,
    allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`],
  });
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    commits,
    vaultRoot,
    close: () =>
      new Promise<void>((r) => {
        app.close();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const post = (h: Harness, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${h.base}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A raw request, so tests can set the Host header (fetch will not). */
function raw(h: Harness, path: string, host: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = request({ host: "127.0.0.1", port: h.port, path, headers: { host } }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("state lists the team, boards and today's budget", async () => {
  const h = await start();
  try {
    const s = (await (await fetch(`${h.base}/api/state`)).json()) as Record<string, any>;
    assert.equal(s.userName, "Kevin");
    assert.deepEqual(s.boards, ["pi.md", "sprint.md", "tasks/interview-synthesis.md"]);
    assert.equal(s.busy, false);
    assert.equal(s.history, true);
    assert.equal(s.budget.state, "ok");
    const ids = s.agents.map((a: { id: string }) => a.id);
    assert.ok(ids.includes("floor-manager") && ids.includes("research-lead") && ids.includes("synthesizer"));
    assert.ok(s.agents.every((a: { state: string }) => a.state === "idle"));
    // The charter (system prompt) is not sent to the browser.
    assert.ok(!JSON.stringify(s).includes("You run the floor"));
  } finally {
    await h.close();
  }
});

test("a room message is routed, answered, saved and committed", async () => {
  const h = await start();
  try {
    const res = await post(h, { text: "Help me plan some research" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.ok, true);
    assert.equal(body.replies.length, 1);
    assert.equal(body.saved, "abc1234");
    assert.ok(body.usage.inputTokens > 0);

    const t = (await (await fetch(`${h.base}/api/transcript?channel=room`)).json()) as { entries: any[] };
    assert.deepEqual(
      t.entries.map((e) => e.from),
      ["user", "research-lead"],
    );
    assert.equal(h.commits.length, 1);
    assert.match(h.commits[0]!, /^Room: "Help me plan some research" \(research-lead\)$/);
  } finally {
    await h.close();
  }
});

test("a DM goes to that agent only and has its own transcript", async () => {
  const h = await start();
  try {
    const res = await post(h, { text: "hello there", dm: "synthesizer" });
    assert.equal(res.status, 200);
    const dm = (await (await fetch(`${h.base}/api/transcript?channel=dm:synthesizer`)).json()) as { entries: any[] };
    assert.deepEqual(
      dm.entries.map((e) => e.from),
      ["user", "synthesizer"],
    );
    const room = (await (await fetch(`${h.base}/api/transcript?channel=room`)).json()) as { entries: any[] };
    assert.equal(room.entries.length, 0);
    assert.match(h.commits[0]!, /^DM: /);
  } finally {
    await h.close();
  }
});

test("works without git installed (no commits, no error)", async () => {
  const h = await start({ git: false });
  try {
    const s = (await (await fetch(`${h.base}/api/state`)).json()) as { history: boolean };
    assert.equal(s.history, false);
    const body = (await (await post(h, { text: "hello @floor-manager" })).json()) as { saved: string | null };
    assert.equal(body.saved, null);
  } finally {
    await h.close();
  }
});

test("bad requests get a clear 4xx and nothing is written", async () => {
  const h = await start();
  try {
    const cases: Array<[Promise<Response>, number, RegExp]> = [
      [post(h, { text: "   " }), 400, /Write a message/],
      [post(h, { text: "hi", dm: "nobody" }), 400, /No active agent "nobody"/],
      [post(h, { text: "hi", focus: "../secret.md" }), 400, /./],
      [post(h, "{not json"), 400, /valid JSON/],
      [post(h, { text: "hi" }, { "content-type": "text/plain" }), 415, /JSON/],
      [post(h, { text: "hi" }, { origin: "https://evil.example" }), 403, /Cross-site/],
    ];
    for (const [pending, status, message] of cases) {
      const res = await pending;
      assert.equal(res.status, status);
      assert.match(((await res.json()) as { error: string }).error, message);
    }
    const t = (await (await fetch(`${h.base}/api/transcript?channel=room`)).json()) as { entries: unknown[] };
    assert.equal(t.entries.length, 0);
    assert.equal(h.commits.length, 0);
  } finally {
    await h.close();
  }
});

test("a same-origin browser request is accepted", async () => {
  const h = await start();
  try {
    const res = await post(h, { text: "hello @floor-manager" }, { origin: h.base.replace("127.0.0.1", "localhost") });
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});

test("a foreign Host header is refused (DNS rebinding guard)", async () => {
  const h = await start();
  try {
    assert.equal(await raw(h, "/api/state", "evil.example"), 403);
    assert.equal(await raw(h, "/", `evil.example:${h.port}`), 403);
    assert.equal(await raw(h, "/api/state", `localhost:${h.port}`), 200);
  } finally {
    await h.close();
  }
});

test("a second message while the team is busy gets 409", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const demo = createDemoProvider({ delayMs: 0 });
  const slow: Provider = {
    id: "slow",
    async complete(req) {
      if (!req.tools.some((t) => t.name === "route")) await gate;
      return demo.complete(req);
    },
  };
  const h = await start({ provider: slow });
  try {
    const first = post(h, { text: "plan the research" });
    await new Promise((r) => setTimeout(r, 100));
    const state = (await (await fetch(`${h.base}/api/state`)).json()) as { busy: boolean; agents: any[] };
    assert.equal(state.busy, true);
    assert.ok(state.agents.some((a) => a.state === "thinking"));
    const second = await post(h, { text: "another one" });
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).status, 200);
    const after = (await (await fetch(`${h.base}/api/state`)).json()) as { busy: boolean; agents: any[] };
    assert.equal(after.busy, false);
    assert.ok(after.agents.every((a) => a.state === "idle"));
  } finally {
    release();
    await h.close();
  }
});

test("expired credentials come back as 401 with the fix", async () => {
  const failing: Provider = {
    id: "failing",
    async complete() {
      throw new ProviderAuthError("AWS credentials are missing or expired.", "Run gimme-aws-creds, then try again.");
    },
  };
  const h = await start({ provider: failing });
  try {
    const res = await post(h, { text: "hello @floor-manager" });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body.kind, "auth");
    assert.match(body.hint!, /gimme-aws-creds/);
    // The server recovers: not stuck busy.
    const s = (await (await fetch(`${h.base}/api/state`)).json()) as { busy: boolean; agents: any[] };
    assert.equal(s.busy, false);
    assert.ok(s.agents.every((a) => a.state === "idle"));
  } finally {
    await h.close();
  }
});

test("hitting the daily limit comes back as 429 with the budget", async () => {
  const h = await start({ dailyLimit: 1 });
  try {
    // The call that crosses the limit is allowed to finish...
    assert.equal((await post(h, { text: "hello @floor-manager" })).status, 200);
    // ...and the next one is refused.
    const res = await post(h, { text: "hello again @floor-manager" });
    assert.equal(res.status, 429);
    const body = (await res.json()) as { kind: string; error: string; budget: { state: string } };
    assert.equal(body.kind, "budget");
    assert.match(body.error, /Daily token limit reached/);
    assert.equal(body.budget.state, "stopped");
  } finally {
    await h.close();
  }
});

test("the event stream carries what a UI needs, in order", async () => {
  const h = await start();
  try {
    const events: Array<{ event: string; data: any }> = [];
    const ready = new Promise<void>((resolveReady, reject) => {
      const req = request(`${h.base}/api/events`, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (ev && data) {
              events.push({ event: ev, data: JSON.parse(data) });
              if (ev === "hello") resolveReady();
            }
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
    await ready;
    await post(h, { text: "Here are my interview notes" });
    await new Promise((r) => setTimeout(r, 50));

    const kinds = events.map((e) => (e.event === "room" ? `room:${e.data.type}` : e.event));
    assert.equal(kinds[0], "hello");
    assert.ok(kinds.indexOf("busy") < kinds.indexOf("room:routing"));
    for (const k of ["room:entry", "room:routing", "room:agent_state", "budget"]) assert.ok(kinds.includes(k), k);
    assert.equal(kinds.at(-1), "busy");
    assert.equal(events.at(-1)!.data.busy, false);
    const states = events.filter((e) => e.data.type === "agent_state").map((e) => `${e.data.agentId}:${e.data.state}`);
    assert.deepEqual(states.slice(0, 1), ["synthesizer:thinking"]);
    assert.equal(states.at(-1), "synthesizer:idle");
    // Raw model internals are not forwarded.
    assert.ok(!kinds.includes("room:turn"));
  } finally {
    await h.close();
  }
});

test("boards are readable and cannot escape the boards folder", async () => {
  const h = await start();
  try {
    const ok = (await (await fetch(`${h.base}/api/board?name=pi.md`)).json()) as { text: string };
    assert.match(ok.text, /PI-1/);
    assert.equal((await fetch(`${h.base}/api/board?name=nope.md`)).status, 404);
    assert.equal((await fetch(`${h.base}/api/board?name=${encodeURIComponent("../agents/floor-manager.md")}`)).status, 400);
  } finally {
    await h.close();
  }
});

test("transcript channel is validated", async () => {
  const h = await start();
  try {
    assert.equal((await fetch(`${h.base}/api/transcript?channel=bogus`)).status, 400);
    assert.equal((await fetch(`${h.base}/api/transcript?channel=dm:nobody`)).status, 404);
    assert.equal((await fetch(`${h.base}/api/transcript?channel=dm:..%2F..%2Fx`)).status, 404);
  } finally {
    await h.close();
  }
});

test("static files are served and cannot escape the public folder", async () => {
  const h = await start();
  try {
    const index = await fetch(`${h.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type")!, /text\/html/);
    assert.match(await index.text(), /<title>hi<\/title>/);
    assert.match((await fetch(`${h.base}/app.js`)).headers.get("content-type")!, /javascript/);
    assert.equal((await fetch(`${h.base}/missing.css`)).status, 404);
    assert.equal((await fetch(`${h.base}/sub`)).status, 404);
    assert.equal((await fetch(`${h.base}/..%2f..%2f..%2fetc%2fpasswd`)).status, 404);
    assert.equal((await fetch(`${h.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${h.base}/`, { method: "DELETE" })).status, 405);
  } finally {
    await h.close();
  }
});

const decide = (h: Harness, id: string, body: unknown) =>
  fetch(`${h.base}/api/approvals/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function fileRequest(h: Harness) {
  const { createApproval } = await import("@am/core");
  return createApproval(openVault(h.vaultRoot), {
    actor: "synthesizer",
    board: "sprint.md",
    level: "sprint",
    why: "More interviews",
    change: { kind: "add", title: "Interview more users", status: "proposed", fields: { parent: "PI-1" } },
    approvers: ["floor-manager"],
    needed: "Sprint board changes go to the Floor manager",
  });
}

test("the inbox lists requests, state counts the pending ones, and approving writes and commits", async () => {
  const h = await start();
  try {
    assert.deepEqual(((await (await fetch(`${h.base}/api/approvals`)).json()) as any).approvals, []);
    const ap = await fileRequest(h);
    const state = (await (await fetch(`${h.base}/api/state`)).json()) as Record<string, any>;
    assert.equal(state.approvals, 1);
    const list = (await (await fetch(`${h.base}/api/approvals`)).json()) as any;
    assert.equal(list.approvals[0].id, ap.id);
    assert.equal(list.approvals[0].summary, 'Add proposed item "Interview more users" (parent: PI-1)');

    const res = await decide(h, ap.id, { decision: "approve", reason: "ok" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.approval.status, "approved");
    assert.equal(body.saved, "abc1234");
    assert.match(h.commits.at(-1)!, /^Approvals: approved AP-1/);
    const board = (await (await fetch(`${h.base}/api/board?name=sprint.md`)).json()) as { text: string };
    assert.match(board.text, /SP-3 \[proposed\] Interview more users/);
    assert.equal(((await (await fetch(`${h.base}/api/state`)).json()) as any).approvals, 0);
    assert.equal(((await (await fetch(`${h.base}/api/approvals?status=approved`)).json()) as any).approvals.length, 1);
  } finally {
    await h.close();
  }
});

test("rejecting leaves the board alone; bad decisions get clear errors", async () => {
  const h = await start();
  try {
    const ap = await fileRequest(h);
    assert.equal((await decide(h, ap.id, { decision: "maybe" })).status, 400);
    assert.equal((await decide(h, ap.id, { decision: "reject", reason: 5 })).status, 400);
    assert.equal((await decide(h, "AP-99", { decision: "approve" })).status, 404);
    assert.equal((await decide(h, ap.id, { decision: "reject", reason: "no" })).status, 200);
    assert.equal((await decide(h, ap.id, { decision: "approve" })).status, 409);
    const board = (await (await fetch(`${h.base}/api/board?name=sprint.md`)).json()) as { text: string };
    assert.doesNotMatch(board.text, /Interview more users/);
    assert.equal((await fetch(`${h.base}/api/approvals?status=bogus`)).status, 400);
  } finally {
    await h.close();
  }
});

test("a stale request comes back 409 with kind stale and stays pending", async () => {
  const h = await start();
  try {
    const { createApproval } = await import("@am/core");
    const ap = await createApproval(openVault(h.vaultRoot), {
      actor: "synthesizer",
      board: "pi.md",
      level: "pi",
      why: "",
      change: { kind: "set_status", id: "PI-9", status: "done" },
      approvers: ["user"],
      needed: "x",
    });
    const res = await decide(h, ap.id, { decision: "approve" });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).kind, "stale");
    assert.equal(((await (await fetch(`${h.base}/api/state`)).json()) as any).approvals, 1);
  } finally {
    await h.close();
  }
});

test("approving needs a same-origin JSON request", async () => {
  const h = await start();
  try {
    const ap = await fileRequest(h);
    const evil = await fetch(`${h.base}/api/approvals/${ap.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(evil.status, 403);
    const plain = await fetch(`${h.base}/api/approvals/${ap.id}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(plain.status, 415);
  } finally {
    await h.close();
  }
});

test("state describes each board, and a board comes with its hierarchy problems", async () => {
  const h = await start();
  try {
    const s = (await (await fetch(`${h.base}/api/state`)).json()) as Record<string, any>;
    assert.deepEqual(s.boardInfo.map((b: any) => [b.name, b.level]), [
      ["pi.md", "pi"],
      ["sprint.md", "sprint"],
      ["tasks/interview-synthesis.md", "task"],
    ]);
    assert.deepEqual(s.boardInfo[1].items, ["SP-1", "SP-2"]);
    assert.match(s.boardInfo[0].title, /PI board/);
    const clean = (await (await fetch(`${h.base}/api/board?name=sprint.md`)).json()) as any;
    assert.deepEqual(clean.issues, []);
    await writeFile(join(h.vaultRoot, "boards", "sprint.md"), "- SP-1 [active] Lost | parent: PI-9\n");
    const bad = (await (await fetch(`${h.base}/api/board?name=sprint.md`)).json()) as any;
    assert.deepEqual(bad.issues.map((i: any) => [i.itemId, i.kind]), [["SP-1", "unknown_parent"]]);
  } finally {
    await h.close();
  }
});
