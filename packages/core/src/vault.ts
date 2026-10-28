import { join, resolve, sep } from "node:path";

/** Ids become file names, so keep them boring. This also blocks path traversal. */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function assertValidId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Invalid id "${id}" (use lowercase letters, digits and dashes)`);
}

export type Vault = {
  root: string;
  agentsDir: string;
  /** One JSON file per approval request. */
  approvalsDir: string;
  roomFile: string;
  dmFile(agentId: string): string;
  notes(agentId: string): { dir: string; pinned: string; log: string };
  /** Resolve a board file inside <root>/boards. Throws if the name escapes that folder. */
  boardPath(name: string): string;
};

/** Paths only: opening a vault does not touch the disk. Files and folders are created on first write. */
export function openVault(root: string): Vault {
  const base = resolve(root);
  const boardsDir = join(base, "boards");
  return {
    root: base,
    agentsDir: join(base, "agents"),
    approvalsDir: join(base, "approvals"),
    roomFile: join(base, "rooms", "main.jsonl"),
    dmFile(agentId) {
      assertValidId(agentId);
      return join(base, "rooms", "dm", `${agentId}.jsonl`);
    },
    notes(agentId) {
      assertValidId(agentId);
      const dir = join(base, "notes", agentId);
      return { dir, pinned: join(dir, "pinned.md"), log: join(dir, "log.md") };
    },
    boardPath(name) {
      const full = resolve(boardsDir, name);
      if (full !== boardsDir && !full.startsWith(boardsDir + sep)) {
        throw new Error(`Board "${name}" is outside the boards folder`);
      }
      if (!full.endsWith(".md")) throw new Error(`Board "${name}" must be a .md file`);
      return full;
    },
  };
}
