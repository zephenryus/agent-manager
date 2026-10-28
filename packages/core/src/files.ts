import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const CHUNK = 8 * 1024;

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Last `n` lines of a file without reading the whole file. Missing file -> []. */
export async function readLastLines(path: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let position = size;
    let newlines = 0;
    // Need n+1 newlines (or the start of the file) to be sure the first kept line is complete.
    while (position > 0 && newlines <= n) {
      const length = Math.min(CHUNK, position);
      position -= length;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, position);
      chunks.unshift(buf);
      for (const byte of buf) if (byte === 0x0a) newlines++;
    }
    const lines = splitLines(Buffer.concat(chunks).toString("utf8"));
    // If we stopped mid-file, the first line may be partial: drop it.
    const complete = position > 0 ? lines.slice(1) : lines;
    return complete.slice(-n);
  } finally {
    await handle.close();
  }
}

/** First `n` lines of a file without reading the whole file. Missing file -> []. */
export async function readFirstLines(path: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let position = 0;
    let newlines = 0;
    while (position < size && newlines < n) {
      const length = Math.min(CHUNK, size - position);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, position);
      position += length;
      chunks.push(buf);
      for (const byte of buf) if (byte === 0x0a) newlines++;
    }
    return splitLines(Buffer.concat(chunks).toString("utf8")).slice(0, n);
  } finally {
    await handle.close();
  }
}

/** Append one line (creating parent folders). Newlines inside `line` are flattened to spaces. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line.replace(/\r?\n/g, " ")}\n`, "utf8");
}
