import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider, Usage } from "./types.ts";

export type BudgetState = "ok" | "warn" | "stopped";

export type Prices = { inputPerMTok: number; outputPerMTok: number };

export type BudgetSnapshot = {
  /** Local calendar day, YYYY-MM-DD. The budget resets when it changes. */
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Daily limit, or null when there is no limit (for example with a free local model). */
  limit: number | null;
  /** totalTokens / limit (can exceed 1 by at most one model call). Null when there is no limit. */
  fraction: number | null;
  /** Always "ok" when there is no limit. */
  state: BudgetState;
  /** Only when prices are configured. */
  estimatedCostUsd?: number;
};

export type BudgetOptions = {
  /** Folder for the daily ledgers (<dir>/YYYY-MM-DD.jsonl). Created on first write. */
  dir: string;
  /** Daily limit in tokens (input + output), or null for no limit: usage is still counted, nothing ever stops. */
  dailyLimit: number | null;
  /** Fraction of the limit at which state becomes "warn". Default 0.8. */
  warnAt?: number;
  prices?: Prices;
  now?: () => Date;
};

export type Budget = {
  snapshot(): Promise<BudgetSnapshot>;
  /** Throws BudgetError when today's limit is used up. */
  assertAvailable(): Promise<void>;
  record(usage: Usage, label: string): Promise<BudgetSnapshot>;
  subscribe(listener: (s: BudgetSnapshot) => void): () => void;
};

export class BudgetError extends Error {
  readonly snapshot: BudgetSnapshot;
  constructor(snapshot: BudgetSnapshot) {
    super(
      `Daily token limit reached (${snapshot.totalTokens.toLocaleString("en-US")} of ` +
        `${(snapshot.limit ?? 0).toLocaleString("en-US")} tokens used today). ` +
        `Raise dailyTokenLimit in your config, or set it to null for no limit.`,
    );
    this.name = "BudgetError";
    this.snapshot = snapshot;
  }
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createBudget(opts: BudgetOptions): Budget {
  const limit = opts.dailyLimit;
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("dailyLimit must be a positive number of tokens, or null for no limit");
  }
  const now = opts.now ?? (() => new Date());
  const warnAt = opts.warnAt ?? 0.8;
  const listeners = new Set<(s: BudgetSnapshot) => void>();

  let loaded: { date: string; input: number; output: number } | null = null;
  // One operation at a time, so two concurrent calls cannot double-load or lose an update.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  async function today(): Promise<{ date: string; input: number; output: number }> {
    const date = localDate(now());
    if (loaded && loaded.date === date) return loaded;
    let input = 0;
    let output = 0;
    try {
      const text = await readFile(join(opts.dir, `${date}.jsonl`), "utf8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const row = JSON.parse(line) as { inputTokens?: unknown; outputTokens?: unknown };
          if (typeof row.inputTokens === "number") input += row.inputTokens;
          if (typeof row.outputTokens === "number") output += row.outputTokens;
        } catch {
          // skip a damaged line
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    loaded = { date, input, output };
    return loaded;
  }

  function toSnapshot(t: { date: string; input: number; output: number }): BudgetSnapshot {
    const total = t.input + t.output;
    const fraction = limit === null ? null : total / limit;
    const state: BudgetState =
      limit === null || fraction === null ? "ok" : total >= limit ? "stopped" : fraction >= warnAt ? "warn" : "ok";
    const snap: BudgetSnapshot = {
      date: t.date,
      inputTokens: t.input,
      outputTokens: t.output,
      totalTokens: total,
      limit,
      fraction,
      state,
    };
    if (opts.prices) {
      snap.estimatedCostUsd =
        (t.input / 1_000_000) * opts.prices.inputPerMTok + (t.output / 1_000_000) * opts.prices.outputPerMTok;
    }
    return snap;
  }

  return {
    snapshot: () => exclusive(async () => toSnapshot(await today())),
    assertAvailable: () =>
      exclusive(async () => {
        const snap = toSnapshot(await today());
        if (snap.state === "stopped") throw new BudgetError(snap);
      }),
    record: (usage, label) =>
      exclusive(async () => {
        const t = await today();
        await mkdir(opts.dir, { recursive: true });
        const row = { ts: now().toISOString(), label, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        await appendFile(join(opts.dir, `${t.date}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
        t.input += usage.inputTokens;
        t.output += usage.outputTokens;
        const snap = toSnapshot(t);
        for (const listener of listeners) listener(snap);
        return snap;
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Wrap a provider so every model call is checked against, and counted in, the daily budget. */
export function withBudget(provider: Provider, budget: Budget): Provider {
  return {
    id: provider.id,
    async complete(req) {
      await budget.assertAvailable();
      const res = await provider.complete(req);
      await budget.record(res.usage, provider.id);
      return res;
    },
  };
}
