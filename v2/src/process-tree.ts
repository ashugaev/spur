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

export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  rssKb: number;
  elapsedSeconds: number;
  args: string;
}

// Parses a POSIX `ps -o etime=` token: "MM:SS", "HH:MM:SS", or
// "D-HH:MM:SS". Returns 0 on anything that does not match — callers use this
// as "age unknown", never as a hard failure (etime formatting is
// procps-specific and not worth failing the whole snapshot over).
export function parseElapsedSeconds(etime: string): number {
  const trimmed = etime.trim();
  const dayMatch = /^(\d+)-(.+)$/.exec(trimmed);
  const days = dayMatch ? Number.parseInt(dayMatch[1] ?? "", 10) : 0;
  const rest = dayMatch ? (dayMatch[2] ?? "") : trimmed;
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) {
    return 0;
  }
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  const hours = numbers.length === 3 ? (numbers[0] ?? 0) : 0;
  const minutes = numbers.length === 3 ? numbers[1] : numbers[0];
  const seconds = numbers.length === 3 ? numbers[2] : numbers[1];
  if (!Number.isFinite(days) || minutes === undefined || seconds === undefined) {
    return 0;
  }
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

// One `ps -eo pid=,ppid=,rss=,etime=,args=` fork (execFile, no shell).
// Malformed rows are skipped. Never throws — a failed `ps` reads as "no
// processes", the same degrade-quietly contract as the rest of this module.
export async function listProcesses(): Promise<ProcessSnapshotEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,etime=,args="]));
  } catch {
    return [];
  }
  const processes: ProcessSnapshotEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // The trailing args group is optional: a zombie's argv is reclaimed, so
    // `ps` emits an empty args column, `.trim()` strips the now-trailing
    // separator whitespace, and a required `\s+` before the group would
    // reject the whole row — making a zombie invisible to every scan.
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const etime = match[4] ?? "";
    const args = match[5] ?? "";
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(rssKb)) continue;
    processes.push({ pid, ppid, rssKb, elapsedSeconds: parseElapsedSeconds(etime), args });
  }
  return processes;
}

// BFS over ppid links, root first (root included). A cycle cannot loop
// forever: `seen` is checked before a pid is queued.
export function collectDescendants(
  rootPid: number,
  processes: readonly ProcessSnapshotEntry[],
): number[] {
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

// `ps -o stat=` zombie state codes ("Z", "Zs", "Z+", ...) on both Linux and
// macOS: any state beginning with "Z". Exported so the zombie rule itself is
// directly unit-testable — a real OS zombie cannot be manufactured from
// inside this Node process (libuv reaps every child it spawns as soon as it
// exits), so the parsing rule is what a fast test can actually pin down.
export function isZombieProcessState(state: string): boolean {
  return state.trim().startsWith("Z");
}

// Alive unless `ps` has no row for the pid, or reports it as a zombie. A
// signal-0 probe (kill(pid, 0)) is NOT enough here: a zombie still answers
// it (the kernel keeps the pid entry until the parent reaps it), so a
// captured agent that exited but was left unreaped would report "alive"
// forever — wedging every failOnSurvivors:true caller (restore/relaunch/
// switchAuth) with no bypass, since `force` only gates the separate P2 scan,
// never a P1 survivor. `ps -o stat=` is the portable way to see through
// that on both Linux and macOS, so this stays a leaf `ps` call rather than a
// /proc read. This is the canonical copy — playwright.ts's leak sweep uses
// it. workspace.ts:100, ids.ts:20 and update.ts:139 each keep a deliberately
// different kill(pid,0)-based errno policy for their own call site
// (rethrow-unknown, EPERM-only, etc.) and are intentionally NOT consolidated
// onto this one — they answer a different question (can THIS process signal
// that pid) than the one this copy now answers (is the pid a live,
// non-zombie process at all).
export async function isPidAlive(pid: number): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]));
  } catch {
    return false;
  }
  const state = stdout.trim();
  if (!state) {
    return false;
  }
  return !isZombieProcessState(state);
}

// Best-effort signal send. Swallows ESRCH (already dead) and any other
// errno — the caller is doing a best-effort teardown sweep, not depending on
// the signal landing.
export function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Not actionable here; the poll loop that follows observes the outcome.
  }
}

// "ok" = the read succeeded, `value` is the var's value (or undefined if the
// var is absent from that process' environment) — distinct from "unreadable"
// (dead pid, a proc race, permission, or no procfs at all).
export type ProcessEnvRead = { status: "ok"; value: string | undefined } | { status: "unreadable" };

// Linux /proc/<pid>/environ only: a NUL-separated KEY=VALUE blob. There is no
// portable equivalent (macOS does not expose another process' environment to
// an unprivileged reader), so this is deliberately Linux-only.
export async function readProcessEnvValue(pid: number, key: string): Promise<ProcessEnvRead> {
  let content: string;
  try {
    content = await readFile(`/proc/${pid}/environ`, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  const prefix = `${key}=`;
  for (const entry of content.split("\0")) {
    if (entry.startsWith(prefix)) {
      return { status: "ok", value: entry.slice(prefix.length) };
    }
  }
  return { status: "ok", value: undefined };
}

// Platform capability probe: can this process read process environments at
// all, evaluated against itself (always readable if procfs exists and is
// readable). False on macOS or anywhere without procfs; callers must treat
// that as "cannot tell", never as "no processes found".
export async function canReadProcessEnv(): Promise<boolean> {
  return (await readProcessEnvValue(process.pid, "PATH")).status === "ok";
}
