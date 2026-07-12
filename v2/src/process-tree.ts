import { readFile } from "node:fs/promises";

// Resolves a process' parent pid. Returns null when the pid cannot be read
// (dead process, or no procfs on this platform).
export type PpidReader = (pid: number) => Promise<number | null>;

// Parses ppid from /proc/<pid>/stat. The comm field is wrapped in parentheses
// and may contain spaces, so anchor parsing to the last ')': the fields after
// it are `state ppid ...`.
async function readPpidFromProc(pid: number): Promise<number | null> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = content.lastIndexOf(")");
    if (close === -1) {
      return null;
    }
    const fields = content
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

// True when `pid` is `ancestorPid` itself or one of its descendants. Walks the
// parent chain upward, bounded by maxDepth to avoid cycles from pid reuse.
export async function isProcessDescendantOf(
  pid: number,
  ancestorPid: number,
  readPpid: PpidReader = readPpidFromProc,
  maxDepth = 24,
): Promise<boolean> {
  if (pid === ancestorPid) {
    return true;
  }
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    const ppid = await readPpid(current);
    if (ppid === null || ppid <= 1 || ppid === current) {
      return false;
    }
    if (ppid === ancestorPid) {
      return true;
    }
    current = ppid;
  }
  return false;
}

// Probes whether process ancestry is introspectable at all on this host. When
// false (e.g. no procfs), callers must not treat an empty pane match as
// authoritative and should fall back to weaker keys.
export async function canReadProcessTree(
  pid: number,
  readPpid: PpidReader = readPpidFromProc,
): Promise<boolean> {
  return (await readPpid(pid)) !== null;
}
