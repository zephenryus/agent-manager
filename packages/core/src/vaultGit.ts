import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnavailableError";
  }
}

export type VaultGit = {
  /** Make the vault a git repo if it is not one yet. */
  ensureRepo(): Promise<void>;
  /** Commit everything that changed. Returns the short hash, or null if there was nothing to commit. */
  commit(message: string): Promise<string | null>;
};

type RunResult = { code: number; stdout: string; stderr: string };

function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const e = error as NodeJS.ErrnoException & { code?: string | number };
        if (e.code === "ENOENT") {
          reject(new GitUnavailableError("git is not installed or not on PATH"));
          return;
        }
        resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function mustRun(cwd: string, args: string[]): Promise<string> {
  const r = await run(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

const AUTHOR = ["-c", "user.name=Agent Manager", "-c", "user.email=agent-manager@localhost"];

/** Git history for the vault: every change is undoable. Commands run one at a time. */
export function createVaultGit(root: string): VaultGit {
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    ensureRepo: () =>
      exclusive(async () => {
        try {
          await access(join(root, ".git"));
          return;
        } catch {
          // not a repo yet
        }
        await mustRun(root, ["init", "-b", "main"]);
      }),
    commit: (message) =>
      exclusive(async () => {
        await mustRun(root, ["add", "-A"]);
        const status = await mustRun(root, ["status", "--porcelain"]);
        if (status === "") return null;
        // Use the person's own git identity when they have one; otherwise fall back to a neutral one.
        const hasIdentity = (await run(root, ["config", "user.email"])).stdout.trim() !== "";
        await mustRun(root, [...(hasIdentity ? [] : AUTHOR), "commit", "-m", message.slice(0, 200)]);
        return mustRun(root, ["rev-parse", "--short", "HEAD"]);
      }),
  };
}
