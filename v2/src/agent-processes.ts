// Attributes live agent processes to the session that owns them.
//
// DECISION RULE: ownership keys on the session id carried in a process'
// SPUR_SESSION environment (or, for a pane's own children, on descent from
// the pane pid) — never on cwd/worktree. Multiple sessions legitimately
// share one working directory (shared-desk siblings, a worktree:false
// project), so grouping by cwd produces false positives; the session id is
// the only fact that is unique per launch.
import { setTimeout as sleep } from "node:timers/promises";
import { agentProcessMatchers } from "./agents/index.js";
import { listSessions } from "./metadata.js";
import {
  canReadProcessEnv,
  collectDescendants,
  listProcesses,
  readProcessEnvValue,
  signalPid,
  snapshotProcessLiveness,
  type ProcessSnapshotEntry,
} from "./process-tree.js";
import type { AgentName } from "./types.js";
// Type-only: checkAgentProcessOwnership adapts a scan into the doctor
// registry's shared check shape.
import type { HostInstallCheck } from "./host-install.js";

// pid only: every consumer of a capture/scan result (terminateAgentProcesses,
// killAgentPaneAndConfirmExit's logging, assertNoForeignAgentForSession) acts
// on the pid alone. rss/age/args belong to the doctor-facing
// UnownedAgentProcess below, which is built straight from ProcessSnapshotEntry
// via toFinding, not from this type.
export interface AgentProcessRef {
  pid: number;
}

function toRef(proc: ProcessSnapshotEntry): AgentProcessRef {
  return { pid: proc.pid };
}

// Same word-boundary matching isProcessRunningInTmux (runtime-tmux.ts) uses,
// applied to the whole process table instead of a tty-filtered slice — this
// module deliberately never touches tmux (see the module header of the
// caller-supplies-panePid contract below).
function compileMatchers(matchers: readonly string[]): RegExp[] {
  return matchers
    .filter((matcher) => matcher.trim().length > 0)
    .map(
      (matcher) => new RegExp(`(?:^|/)${matcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`),
    );
}

// Collapses a set of candidate pids to the shallowest members of their own
// ancestry: a pid covered by another candidate's descendant tree is dropped.
// Ancestry is resolved over the FULL process table (not just the
// candidates), so an intermediate non-matching process (a shell wrapper, for
// example) does not break the chain.
//
// A genuine OS ppid chain cannot cycle, but a synthetic/adversarial process
// table (or a pid-reuse race caught mid-transition) could — collectDescendants
// bounds that with its own `seen` set, so two candidates on a ppid cycle
// mutually "cover" each other here. Filtering both would return [] and
// suppress a real verdict entirely, so a mutual pair is resolved by keeping
// the lower pid instead of dropping both.
function collapseToShallowest(
  pids: number[],
  allProcesses: readonly ProcessSnapshotEntry[],
): number[] {
  if (pids.length <= 1) {
    return pids;
  }
  const descendantsOf = new Map<number, Set<number>>();
  for (const pid of pids) {
    descendantsOf.set(pid, new Set(collectDescendants(pid, allProcesses)));
  }
  const covered = new Set<number>();
  for (const pid of pids) {
    for (const other of pids) {
      if (other === pid) continue;
      const otherCoversPid = descendantsOf.get(other)?.has(pid) ?? false;
      if (!otherCoversPid) continue;
      const pidCoversOther = descendantsOf.get(pid)?.has(other) ?? false;
      if (pidCoversOther) {
        // Mutual coverage: a ppid cycle joins pid and other. Keep the lower
        // pid deterministically instead of dropping both.
        if (pid > other) {
          covered.add(pid);
        }
        continue;
      }
      covered.add(pid);
    }
  }
  return pids.filter((pid) => !covered.has(pid));
}

// ONE ps snapshot per call, not one fork per pid — the poll loop below can
// run this up to 21 times per grace window per stage. "unavailable" (the
// snapshot could not be taken) must never read as "everyone died this
// round": every pid is kept as still alive so the poll keeps going instead
// of falsely declaring a survivor gone.
async function filterAlivePids(pids: readonly number[]): Promise<number[]> {
  const snapshot = await snapshotProcessLiveness();
  if (snapshot.status === "unavailable") {
    return [...pids];
  }
  return pids.filter((pid) => snapshot.alivePids.has(pid));
}

async function pollUntilDead(pids: number[], graceMs: number, pollMs: number): Promise<number[]> {
  const deadline = Date.now() + graceMs;
  let alive = await filterAlivePids(pids);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    alive = await filterAlivePids(alive);
  }
  return alive;
}

// P1, pane-rooted and exact: descendants of `panePid` whose args match this
// session's own agent matchers. `panePid: null` (pane already gone, or the
// caller never resolved one) reads as "nothing to capture" — never throws.
export async function capturePaneAgentProcesses(input: {
  panePid: number | null;
  processMatchers: readonly string[];
}): Promise<AgentProcessRef[]> {
  if (input.panePid === null) {
    return [];
  }
  const matchers = compileMatchers(input.processMatchers);
  if (matchers.length === 0) {
    return [];
  }
  const processes = await listProcesses();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const orderedPids = collectDescendants(input.panePid, processes);
  const refs: AgentProcessRef[] = [];
  for (const pid of orderedPids) {
    const proc = byPid.get(pid);
    if (proc && matchers.some((matcher) => matcher.test(proc.args))) {
      refs.push(toRef(proc));
    }
  }
  return refs;
}

export type AgentTerminationOutcome = { status: "clear" } | { status: "survivors"; pids: number[] };

const DEFAULT_GRACE_MS = 2_000;
const POLL_MS = 100;

// Poll -> SIGHUP -> poll -> SIGTERM -> poll -> SIGKILL -> poll. `processes`
// is expected root-first (capturePaneAgentProcesses' order); signalling
// walks it leaves-first so a parent is never signalled before its children.
// Portable: signals and a `ps`-based liveness probe only, no /proc.
export async function terminateAgentProcesses(
  processes: readonly AgentProcessRef[],
  options?: { hupGraceMs?: number; termGraceMs?: number; killGraceMs?: number },
): Promise<AgentTerminationOutcome> {
  const hupGraceMs = options?.hupGraceMs ?? DEFAULT_GRACE_MS;
  const termGraceMs = options?.termGraceMs ?? DEFAULT_GRACE_MS;
  const killGraceMs = options?.killGraceMs ?? DEFAULT_GRACE_MS;

  let survivors = await filterAlivePids([...processes].reverse().map((proc) => proc.pid));
  if (survivors.length === 0) {
    return { status: "clear" };
  }

  for (const pid of survivors) signalPid(pid, "SIGHUP");
  survivors = await pollUntilDead(survivors, hupGraceMs, POLL_MS);
  if (survivors.length === 0) {
    return { status: "clear" };
  }

  for (const pid of survivors) signalPid(pid, "SIGTERM");
  survivors = await pollUntilDead(survivors, termGraceMs, POLL_MS);
  if (survivors.length === 0) {
    return { status: "clear" };
  }

  for (const pid of survivors) signalPid(pid, "SIGKILL");
  survivors = await pollUntilDead(survivors, killGraceMs, POLL_MS);
  if (survivors.length === 0) {
    return { status: "clear" };
  }

  return { status: "survivors", pids: survivors };
}

export type SessionAgentScan =
  | { status: "unavailable" }
  | { status: "ok"; processes: AgentProcessRef[] };

// P2, env-rooted and heuristic launch guard: processes carrying
// SPUR_SESSION === sessionId that are not this pane's own children
// (excludePanePid's descendants), collapsed to their shallowest ancestor.
// "unavailable" when this platform cannot read process environments — the
// caller MUST treat that as "no finding", never as "duplicate".
export async function findForeignAgentProcessesForSession(input: {
  sessionId: string;
  processMatchers: readonly string[];
  excludePanePid: number | null;
}): Promise<SessionAgentScan> {
  if (!(await canReadProcessEnv())) {
    return { status: "unavailable" };
  }
  const matchers = compileMatchers(input.processMatchers);
  if (matchers.length === 0) {
    return { status: "ok", processes: [] };
  }
  const processes = await listProcesses();
  const excluded = new Set(
    input.excludePanePid !== null ? collectDescendants(input.excludePanePid, processes) : [],
  );
  const candidates = processes.filter(
    (proc) => !excluded.has(proc.pid) && matchers.some((matcher) => matcher.test(proc.args)),
  );

  const sameSession: ProcessSnapshotEntry[] = [];
  for (const proc of candidates) {
    const envRead = await readProcessEnvValue(proc.pid, "SPUR_SESSION");
    if (envRead.status === "ok" && envRead.value === input.sessionId) {
      sameSession.push(proc);
    }
  }

  const byPid = new Map(sameSession.map((proc) => [proc.pid, proc]));
  const roots = collapseToShallowest(
    sameSession.map((proc) => proc.pid),
    processes,
  );
  const refs = roots
    .map((pid) => byPid.get(pid))
    .filter((proc): proc is ProcessSnapshotEntry => proc !== undefined)
    .map(toRef);
  return { status: "ok", processes: refs };
}

export type UnownedAgentReason = "duplicate_for_session" | "terminal_record" | "unknown_session";

export interface UnownedAgentProcess {
  pid: number;
  rssKb: number;
  elapsedSeconds: number;
  sessionId: string;
  agent: AgentName | null;
  worktreePath: string;
  reason: UnownedAgentReason;
}

export type UnownedAgentScan =
  | { status: "unavailable" }
  | { status: "ok"; processes: UnownedAgentProcess[] };

function toFinding(
  proc: ProcessSnapshotEntry,
  sessionId: string,
  agent: AgentName | null,
  worktreePath: string,
  reason: UnownedAgentReason,
): UnownedAgentProcess {
  return {
    pid: proc.pid,
    rssKb: proc.rssKb,
    elapsedSeconds: proc.elapsedSeconds,
    sessionId,
    agent,
    worktreePath,
    reason,
  };
}

// P2, doctor-facing: every live agent process, grouped by the SPUR_SESSION it
// carries, checked against the session record it claims to belong to.
//  - no matching record at all: "unknown_session" (a lingering process from a
//    deleted/unindexed session).
//  - record is completed/killed: "terminal_record" — I3's "not completed or
//    killed" is the only status set that may legitimately own a live agent,
//    so ANY process here is a finding.
//  - record is live (not terminal) and more than one process, after
//    ancestor/descendant collapse, carries its session id:
//    "duplicate_for_session".
//  - record is live and exactly one process (post-collapse) carries its
//    session id: not a finding — I3.
export async function scanUnownedAgentProcesses(dataDir: string): Promise<UnownedAgentScan> {
  if (!(await canReadProcessEnv())) {
    return { status: "unavailable" };
  }
  const sessions = listSessions(dataDir);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const matcherSet = new Set<string>();
  for (const session of sessions) {
    for (const matcher of agentProcessMatchers(session.agent, session.launchCommand)) {
      matcherSet.add(matcher);
    }
  }
  if (matcherSet.size === 0) {
    return { status: "ok", processes: [] };
  }
  const matchers = compileMatchers([...matcherSet]);
  const processes = await listProcesses();
  const candidates = processes.filter((proc) =>
    matchers.some((matcher) => matcher.test(proc.args)),
  );

  const bySessionId = new Map<string, ProcessSnapshotEntry[]>();
  for (const proc of candidates) {
    const envRead = await readProcessEnvValue(proc.pid, "SPUR_SESSION");
    if (envRead.status !== "ok" || !envRead.value) continue;
    const group = bySessionId.get(envRead.value) ?? [];
    group.push(proc);
    bySessionId.set(envRead.value, group);
  }

  const findings: UnownedAgentProcess[] = [];
  for (const [sessionId, group] of bySessionId) {
    const byPid = new Map(group.map((proc) => [proc.pid, proc]));
    const roots = collapseToShallowest(
      group.map((proc) => proc.pid),
      processes,
    )
      .map((pid) => byPid.get(pid))
      .filter((proc): proc is ProcessSnapshotEntry => proc !== undefined);

    const session = sessionById.get(sessionId);
    if (!session) {
      for (const proc of roots) {
        findings.push(toFinding(proc, sessionId, null, "", "unknown_session"));
      }
      continue;
    }
    const terminal = session.status === "completed" || session.status === "killed";
    if (terminal) {
      for (const proc of roots) {
        findings.push(
          toFinding(proc, sessionId, session.agent, session.worktreePath, "terminal_record"),
        );
      }
      continue;
    }
    if (roots.length > 1) {
      for (const proc of roots) {
        findings.push(
          toFinding(proc, sessionId, session.agent, session.worktreePath, "duplicate_for_session"),
        );
      }
    }
  }
  return { status: "ok", processes: findings };
}

function formatAge(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h${remainderMinutes}m` : `${hours}h`;
}

// Doctor adapter. Read-only, never signals. A finding is a leaked process to
// clean up, not a broken install — severity stays "warn" and never flips the
// doctor exit code.
export async function checkAgentProcessOwnership(dataDir: string): Promise<HostInstallCheck> {
  const scan = await scanUnownedAgentProcesses(dataDir);
  if (scan.status === "unavailable") {
    return {
      id: "agent-process-ownership",
      ok: true,
      severity: "info",
      detail: "cannot determine agent process ownership on this platform",
    };
  }
  if (scan.processes.length === 0) {
    return {
      id: "agent-process-ownership",
      ok: true,
      severity: "info",
      detail: "no unowned agent processes found",
    };
  }
  const lines = scan.processes.map(
    (proc) =>
      `pid ${proc.pid} agent ${proc.agent ?? "unknown"} session ${proc.sessionId} reason ${proc.reason} rss ${(proc.rssKb / 1024).toFixed(1)}MB age ${formatAge(proc.elapsedSeconds)} worktree ${proc.worktreePath || "unknown"}`,
  );
  return {
    id: "agent-process-ownership",
    ok: false,
    severity: "warn",
    detail: `${scan.processes.length} unowned agent process(es) found:\n${lines.join("\n")}`,
  };
}
