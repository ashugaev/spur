import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolves a process' parent pid. Returns null when the pid cannot be read
// (dead process, proc race, or no procfs on this platform).
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

export type ProcessOwnership = "owned" | "foreign" | "unknown";

// Classifies `pid` relative to `ancestorPid` by walking the parent chain:
//  - "owned":   pid is ancestorPid, or a descendant of it.
//  - "foreign": the chain resolves to a root (pid <= 1) without passing
//               ancestorPid — a confirmed unrelated process.
//  - "unknown": a parent link could not be read (process just exited, a proc
//               race, or no procfs). Callers must NOT treat this as foreign;
//               it means "cannot tell", not "not mine".
// The walk is bounded by maxDepth to guard against pid-reuse cycles.
export async function classifyProcessOwnership(
  pid: number,
  ancestorPid: number,
  readPpid: PpidReader = readPpidFromProc,
  maxDepth = 24,
): Promise<ProcessOwnership> {
  if (pid === ancestorPid) {
    return "owned";
  }
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    const ppid = await readPpid(current);
    if (ppid === null) {
      return "unknown";
    }
    if (ppid === ancestorPid) {
      return "owned";
    }
    if (ppid <= 1 || ppid === current) {
      return "foreign";
    }
    current = ppid;
  }
  return "foreign";
}

// Probes whether process ancestry is introspectable at all on this host. When
// false (e.g. no procfs), callers must not apply pane-tree filtering and should
// fall back to weaker keys.
export async function canReadProcessTree(
  pid: number,
  readPpid: PpidReader = readPpidFromProc,
): Promise<boolean> {
  return (await readPpid(pid)) !== null;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  args: string;
}

/**
 * Enumerate live processes via `ps` (no shell). Malformed lines are skipped.
 * Moved here (from sidecars/playwright.ts) as the module that already owns
 * process ancestry — cache-retention.ts and playwright.ts both import it
 * rather than either copying it or importing a sidecar module.
 *
 * Returns `null` — never `[]` — when the listing itself could not be
 * trusted: `ps` failed to run, or it produced zero parseable rows (a real
 * `ps -eo` always lists at least init and itself, so an empty table is
 * itself a signal something is wrong, not evidence the host has no
 * processes). Callers that use this as a liveness/in-use signal (notably
 * cache-retention.ts) must treat `null` as "unknown", never as "nothing is
 * running" — the two are indistinguishable from a bare `[]` and conflating
 * them is a fail-open hole. Callers that only use it for best-effort cleanup
 * (playwright.ts's leak sweep) may fall back to `[]` explicitly at the call
 * site instead, since missing a cleanup opportunity is safe.
 */
export async function listProcesses(): Promise<ProcessInfo[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]));
  } catch {
    return null;
  }
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3] ?? "";
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    processes.push({ pid, ppid, args });
  }
  return processes.length > 0 ? processes : null;
}

export function collectDescendants(rootPid: number, processes: readonly ProcessInfo[]): number[] {
  const childrenByPpid = new Map<number, number[]>();
  for (const proc of processes) {
    const list = childrenByPpid.get(proc.ppid) ?? [];
    list.push(proc.pid);
    childrenByPpid.set(proc.ppid, list);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) break;
    ordered.push(pid);
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return ordered;
}
