import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KILL_TREE_GRACE_MS = 1000;
const PROCESS_LIST_TIMEOUT_MS = 2_000;
const PROCESS_LIST_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

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

interface ProcessListOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
}

export type ProcessListRunner = (
  file: string,
  args: string[],
  options: ProcessListOptions,
) => Promise<{ stdout: string }>;

const runProcessList: ProcessListRunner = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, options);
  return { stdout };
};

export type ProcessListResult =
  | { status: "ok"; processes: ProcessSnapshotEntry[] }
  | { status: "unavailable" };

// One `ps -eo pid=,ppid=,rss=,etime=,args=` fork (execFile, no shell), bounded
// by a timeout and a max buffer so a wedged or oversized `ps` cannot hang or
// OOM this process. Malformed rows are skipped.
//
// Returns "unavailable" on ANY exec failure (spawn error, EAGAIN/EMFILE under
// fork pressure, timeout) so a caller that must not guess can tell "ps could
// not run" from "ps ran and found nothing". `-eo` with no `-p` filter has no
// "no such pid" failure mode of its own to confuse with a real exec failure.
// A caller deciding whether a captured agent is still alive MUST refuse on
// "unavailable" rather than read it as "found nobody, so everyone is dead" —
// see snapshotProcessLiveness below for the same policy stated for the poll
// loop, and capturePaneAgentProcesses for the pre-kill capture.
export async function snapshotProcesses(
  run: ProcessListRunner = runProcessList,
): Promise<ProcessListResult> {
  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-eo", "pid=,ppid=,rss=,etime=,args="], {
      encoding: "utf8",
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    }));
  } catch {
    return { status: "unavailable" };
  }
  return { status: "ok", processes: parseProcessRows(stdout) };
}

// Degrade-quietly wrapper for callers that legitimately treat a failed `ps` as
// an empty fleet (leak sweeps, tree kills — they act only on what they can
// see). A caller that must distinguish failure uses snapshotProcesses.
export async function listProcesses(
  run: ProcessListRunner = runProcessList,
): Promise<ProcessSnapshotEntry[]> {
  const result = await snapshotProcesses(run);
  return result.status === "ok" ? result.processes : [];
}

function parseProcessRows(stdout: string): ProcessSnapshotEntry[] {
  const processes: ProcessSnapshotEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
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

export type ProcessLivenessSnapshot =
  | { status: "ok"; alivePids: ReadonlySet<number> }
  | { status: "unavailable" };

// ONE `ps -eo pid=,stat=` fork covering every process on the host, instead
// of one fork per pid. A poll loop tracking N still-alive pids across up to
// 21 rounds per grace window (measured: 14.5ms per fork) would otherwise
// cost 14.5ms * N per round; this costs one fork total, regardless of N —
// see filterAlivePids in agent-processes.ts, the hot-path caller
// (killAgentPaneAndConfirmExit runs on pause/complete/kill/restore/
// relaunch/switchAuth and both spawn-failure teardowns).
//
// "unavailable" on ANY exec failure (spawn error, EAGAIN/EMFILE under fork
// pressure, timeout) — never on "ps ran and found nothing", since `-eo`
// with no `-p` filter has no "no such pid" failure mode of its own to
// confuse with a real exec failure. A snapshot that could not be taken must
// never be read as "found nobody, so everyone is dead": the caller MUST
// treat every pid it was tracking as still alive. A captured agent falsely
// read as dead lets a failOnSurvivors:true caller (restore/relaunch/
// switchAuth) launch a real duplicate over a live one — refusing to
// relaunch is recoverable, launching a duplicate is not.
//
// A zombie still holds its pid entry (the kernel keeps it until the parent
// reaps it) but answers a signal-0 probe, which is why this reads `ps`'s
// state column instead of using kill(pid, 0): a captured agent left
// unreaped would otherwise report "alive" forever.
// Bounded by the same timeout and max buffer as snapshotProcesses: this runs
// inside every poll round on pause/complete/kill/restore/relaunch/switchAuth,
// all of them daemon request paths, so a wedged `ps` must degrade to
// "unavailable" on the timeout instead of hanging the request forever.
export async function snapshotProcessLiveness(
  run: ProcessListRunner = runProcessList,
): Promise<ProcessLivenessSnapshot> {
  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-eo", "pid=,stat="], {
      encoding: "utf8",
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    }));
  } catch {
    return { status: "unavailable" };
  }
  const alivePids = new Set<number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\S+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const state = match[2] ?? "";
    if (!Number.isInteger(pid)) continue;
    if (!isZombieProcessState(state)) {
      alivePids.add(pid);
    }
  }
  return { status: "ok", alivePids };
}

// Single-pid convenience, for a caller outside a poll loop: playwright.ts's
// leak sweep checks each leaked descendant once after a single grace sleep,
// not across repeated rounds, so batching would not save anything there.
// Built on the same snapshot and the same fail-safe contract — an
// indeterminate result reads as alive, never as dead. This is the canonical
// copy; workspace.ts:100, ids.ts:20 and update.ts:139 each keep a
// deliberately different kill(pid,0)-based errno policy for their own call
// site (rethrow-unknown, EPERM-only, etc.) and are intentionally NOT
// consolidated onto this one — they answer a different question (can THIS
// process signal that pid) than the one this copy answers (is the pid a
// live, non-zombie process at all).
export async function isPidAlive(pid: number): Promise<boolean> {
  const snapshot = await snapshotProcessLiveness();
  return snapshot.status === "unavailable" || snapshot.alivePids.has(pid);
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

export type ProcessIdentityReader = (pid: number) => Promise<string | null>;
export type ProcessSignaler = (pid: number, signal: NodeJS.Signals) => void;

// Same /proc/<pid>/stat field used by readPpidFromProc, but reads field[19]
// (starttime) instead of field[1] (ppid): a pid's starttime never changes
// while it lives and is reused only after the kernel would also have to
// reuse the pid itself, so comparing it before/after a grace sleep is how
// killProcessTree tells "this pid is still MY target" from "this pid now
// belongs to something else that grabbed the number after SIGTERM landed".
//
// Exported for the same reason in agent-processes.ts's P1 escalation, which
// signals captured pids up to three grace windows after capturing them.
// Linux-only (/proc): returns null off Linux, which callers must read as
// "identity unverifiable here", never as "not my process".
export async function readProcessIdentity(pid: number): Promise<string | null> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = content.lastIndexOf(")");
    if (close === -1) return null;
    const fields = content
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort. The process may have exited after the identity read.
  }
}

/**
 * SIGTERM the process and all descendants (catches chromium children), wait
 * a grace period, then SIGKILL only the ones whose identity (starttime) is
 * unchanged — a pid reused for something else after SIGTERM is never
 * signaled a second time. Shared by playwright.ts's leaked-server sweep and
 * runtime-tmux.ts's killTmuxSessionTree (sidecar/service pane teardown
 * only — see killAgentPaneAndConfirmExit in session-service.ts for the
 * agent-pane path, which has its own P1 survivor-confirmation contract).
 */
export async function killProcessTree(
  pid: number,
  options: {
    list?: () => Promise<ProcessSnapshotEntry[]>;
    readIdentity?: ProcessIdentityReader;
    signal?: ProcessSignaler;
    wait?: () => Promise<void>;
  } = {},
): Promise<void> {
  // Same fail-open-is-safe reasoning as listProcesses' own doc comment: a
  // teardown kill missing its target list is a missed cleanup, not a
  // deletion guard, so an unavailable ps yields [] here rather than
  // propagating the fail-closed signal cache-retention.ts needs.
  const listTargets = options.list ?? listProcesses;
  const tree = collectDescendants(pid, await listTargets()).reverse();
  const identityReader = options.readIdentity ?? readProcessIdentity;
  const signaler = options.signal ?? signalProcess;
  const identities = new Map<number, string>();
  for (const target of tree) {
    const identity = await identityReader(target);
    if (identity === null) continue;
    identities.set(target, identity);
    signaler(target, "SIGTERM");
  }
  await (options.wait ?? (() => sleep(KILL_TREE_GRACE_MS)))();
  for (const target of tree) {
    const identity = identities.get(target);
    if (identity !== undefined && (await identityReader(target)) === identity) {
      signaler(target, "SIGKILL");
    }
  }
}
