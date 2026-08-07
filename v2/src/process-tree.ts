import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KILL_TREE_GRACE_MS = 1000;
const PROCESS_LIST_TIMEOUT_MS = 2_000;
const PROCESS_LIST_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface ProcessInfo {
  pid: number;
  ppid: number;
  args: string;
}

export type ProcessIdentityReader = (pid: number) => Promise<string | null>;
export type ProcessSignaler = (pid: number, signal: NodeJS.Signals) => void;

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

export async function listProcesses(
  run: ProcessListRunner = runProcessList,
): Promise<ProcessInfo[]> {
  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    }));
  } catch {
    return [];
  }
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      processes.push({ pid, ppid, args: match[3] ?? "" });
    }
  }
  return processes;
}

export function collectDescendants(rootPid: number, processes: readonly ProcessInfo[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of processes) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }
  const ordered: number[] = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  for (const pid of queue) {
    ordered.push(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return ordered;
}

async function readProcessIdentity(pid: number): Promise<string | null> {
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

export async function killProcessTree(
  pid: number,
  options: {
    list?: () => Promise<ProcessInfo[]>;
    readIdentity?: ProcessIdentityReader;
    signal?: ProcessSignaler;
    wait?: () => Promise<void>;
  } = {},
): Promise<void> {
  const tree = collectDescendants(pid, await (options.list ?? listProcesses)()).reverse();
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
