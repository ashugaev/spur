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
  readProcessCwd,
  readProcessEnvValue,
  readProcessIdentity,
  signalPid,
  snapshotProcesses,
  snapshotProcessLiveness,
  type ProcessIdentityReader,
  type ProcessSnapshotEntry,
} from "./process-tree.js";
import { resolveRegisteredDataDirs } from "./registry.js";
import type { AgentName } from "./types.js";
// Type-only: checkAgentProcessOwnership adapts a scan into the doctor
// registry's shared check shape.
import type { HostInstallCheck } from "./host-install.js";

// pid plus an identity token, because P1's escalation signals these pids up
// to three grace windows (~6s) after capturing them, and the pane is killed
// before the first signal — so a captured pid can be recycled inside that
// window. `identity` is the /proc starttime, which changes when the number is
// reused; null means this platform cannot verify identity (no procfs), which
// callers must read as "cannot tell", never as "not my process".
//
// rss/age/args belong to the doctor-facing UnownedAgentProcess below, which is
// built straight from ProcessSnapshotEntry via toFinding, not from this type.
export interface AgentProcessRef {
  pid: number;
  identity: string | null;
}

// A captured pid is still OUR process when it is alive AND its identity token
// is unchanged. A changed token means the number was recycled: do not signal
// it, and do not count it as a survivor — it is a different process, so
// neither action would be about our agent. A null token (no procfs) degrades
// to the liveness answer alone.
async function isStillSameProcess(
  ref: AgentProcessRef,
  readIdentity: ProcessIdentityReader,
): Promise<boolean> {
  if (ref.identity === null) {
    return true;
  }
  return (await readIdentity(ref.pid)) === ref.identity;
}

// Same word-boundary matching isProcessRunningInTmux (runtime-tmux.ts) uses,
// applied to the whole process table instead of a tty-filtered slice — this
// module deliberately never touches tmux (see the module header of the
// caller-supplies-panePid contract below).
function compileSingleMatcher(matcher: string): RegExp {
  return new RegExp(`(?:^|/)${matcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
}

function compileMatchers(matchers: readonly string[]): RegExp[] {
  return matchers.filter((matcher) => matcher.trim().length > 0).map(compileSingleMatcher);
}

interface CompiledAgentMatcher {
  regex: RegExp;
  agents: ReadonlySet<AgentName>;
}

// A record-less process' args may match more than one agent's matchers —
// every agent's matcher set now carries its canonical name from
// AGENT_EXECUTABLES (agents/executable.ts), and cursor's canonical name IS
// the bare literal "agent", which a claude/codex launchCommand-derived
// basename can also produce. An ambiguous match degrades to null; never a
// guess (I7).
function resolveAgentForArgs(
  args: string,
  compiled: readonly CompiledAgentMatcher[],
): AgentName | null {
  const matched = new Set<AgentName>();
  for (const entry of compiled) {
    if (entry.regex.test(args)) {
      for (const agent of entry.agents) matched.add(agent);
    }
  }
  return matched.size === 1 ? ([...matched][0] ?? null) : null;
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
async function filterAliveRefs(
  refs: readonly AgentProcessRef[],
  readIdentity: ProcessIdentityReader,
): Promise<AgentProcessRef[]> {
  const snapshot = await snapshotProcessLiveness();
  const alive =
    snapshot.status === "unavailable"
      ? [...refs]
      : refs.filter((ref) => snapshot.alivePids.has(ref.pid));
  const kept: AgentProcessRef[] = [];
  for (const ref of alive) {
    if (await isStillSameProcess(ref, readIdentity)) {
      kept.push(ref);
    }
  }
  return kept;
}

async function pollUntilDead(
  refs: readonly AgentProcessRef[],
  graceMs: number,
  pollMs: number,
  readIdentity: ProcessIdentityReader,
): Promise<AgentProcessRef[]> {
  const deadline = Date.now() + graceMs;
  let alive = await filterAliveRefs(refs, readIdentity);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    alive = await filterAliveRefs(alive, readIdentity);
  }
  return alive;
}

export type PaneAgentCapture =
  | { status: "ok"; processes: AgentProcessRef[] }
  | { status: "unavailable" };

const CAPTURE_RETRY_DELAY_MS = 100;

// P1, pane-rooted and exact: descendants of `panePid` whose args match this
// session's own agent matchers. `panePid: null` (pane already gone, or the
// caller never resolved one) reads as an empty capture — never throws.
//
// "unavailable" when the process table could not be read. That must NOT
// collapse into an empty capture: an empty capture makes
// terminateAgentProcesses report "clear", which would let a
// failOnSurvivors:true caller relaunch over a possibly-live agent — the exact
// duplicate this module exists to prevent. Same fail-safe policy as
// snapshotProcessLiveness. One retry first, since a `ps` failure here is
// usually transient fork pressure.
export async function capturePaneAgentProcesses(input: {
  panePid: number | null;
  processMatchers: readonly string[];
}): Promise<PaneAgentCapture> {
  if (input.panePid === null) {
    return { status: "ok", processes: [] };
  }
  const matchers = compileMatchers(input.processMatchers);
  if (matchers.length === 0) {
    return { status: "ok", processes: [] };
  }
  let snapshot = await snapshotProcesses();
  if (snapshot.status === "unavailable") {
    await sleep(CAPTURE_RETRY_DELAY_MS);
    snapshot = await snapshotProcesses();
  }
  if (snapshot.status === "unavailable") {
    return { status: "unavailable" };
  }
  const processes = snapshot.processes;
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const orderedPids = collectDescendants(input.panePid, processes);
  const refs: AgentProcessRef[] = [];
  for (const pid of orderedPids) {
    const proc = byPid.get(pid);
    if (proc && matchers.some((matcher) => matcher.test(proc.args))) {
      refs.push({ pid: proc.pid, identity: await readProcessIdentity(proc.pid) });
    }
  }
  return { status: "ok", processes: refs };
}

export type AgentTerminationOutcome = { status: "clear" } | { status: "survivors"; pids: number[] };

const DEFAULT_GRACE_MS = 2_000;
const POLL_MS = 100;

// Poll -> SIGHUP -> poll -> SIGTERM -> poll -> SIGKILL -> poll. `processes`
// is expected root-first (capturePaneAgentProcesses' order); signalling
// walks it leaves-first so a parent is never signalled before its children.
// Portable: signals, a `ps`-based liveness probe, and an identity re-check
// that no-ops where /proc is absent.
//
// Every round re-verifies identity before signalling, so a pid recycled after
// the pane was killed is dropped rather than signalled or counted as a
// survivor (see isStillSameProcess).
export async function terminateAgentProcesses(
  processes: readonly AgentProcessRef[],
  options?: {
    hupGraceMs?: number;
    termGraceMs?: number;
    killGraceMs?: number;
    readIdentity?: ProcessIdentityReader;
  },
): Promise<AgentTerminationOutcome> {
  const hupGraceMs = options?.hupGraceMs ?? DEFAULT_GRACE_MS;
  const termGraceMs = options?.termGraceMs ?? DEFAULT_GRACE_MS;
  const killGraceMs = options?.killGraceMs ?? DEFAULT_GRACE_MS;
  const readIdentity = options?.readIdentity ?? readProcessIdentity;

  let survivors = await filterAliveRefs([...processes].reverse(), readIdentity);
  if (survivors.length === 0) {
    return { status: "clear" };
  }

  for (const signal of ["SIGHUP", "SIGTERM", "SIGKILL"] as const) {
    const graceMs =
      signal === "SIGHUP" ? hupGraceMs : signal === "SIGTERM" ? termGraceMs : killGraceMs;
    for (const ref of survivors) signalPid(ref.pid, signal);
    survivors = await pollUntilDead(survivors, graceMs, POLL_MS, readIdentity);
    if (survivors.length === 0) {
      return { status: "clear" };
    }
  }

  return { status: "survivors", pids: survivors.map((ref) => ref.pid) };
}

// pids only: this scan is a launch-guard verdict, never a signalling target,
// so it needs no identity token (contrast AgentProcessRef, whose pids get
// signalled after a delay).
export type SessionAgentScan = { status: "unavailable" } | { status: "ok"; pids: number[] };

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
    return { status: "ok", pids: [] };
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

  return {
    status: "ok",
    pids: collapseToShallowest(
      sameSession.map((proc) => proc.pid),
      processes,
    ),
  };
}

export type UnownedAgentReason =
  | "duplicate_for_session"
  | "terminal_record"
  | "unknown_session"
  | "foreign_instance";

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
export async function scanUnownedAgentProcesses(
  dataDir: string,
  options?: { resolveForeignDataDirs?: () => readonly string[] },
): Promise<UnownedAgentScan> {
  if (!(await canReadProcessEnv())) {
    return { status: "unavailable" };
  }
  const sessions = listSessions(dataDir);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const matcherSet = new Set<string>();
  const matcherToAgents = new Map<string, Set<AgentName>>();
  for (const session of sessions) {
    for (const matcher of agentProcessMatchers(session.agent, session.launchCommand)) {
      matcherSet.add(matcher);
      const agents = matcherToAgents.get(matcher) ?? new Set<AgentName>();
      agents.add(session.agent);
      matcherToAgents.set(matcher, agents);
    }
  }
  if (matcherSet.size === 0) {
    return { status: "ok", processes: [] };
  }
  const compiledMatchers: CompiledAgentMatcher[] = [...matcherSet]
    .filter((matcher) => matcher.trim().length > 0)
    .map((matcher) => ({
      regex: compileSingleMatcher(matcher),
      agents: matcherToAgents.get(matcher) ?? new Set<AgentName>(),
    }));
  const matchers = compiledMatchers.map((entry) => entry.regex);
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
  const recordless: Array<{ sessionId: string; roots: ProcessSnapshotEntry[] }> = [];
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
      recordless.push({ sessionId, roots });
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

  if (recordless.length > 0) {
    // Lazy foreign lookup: a clean host with every process record-owned pays
    // zero extra config parses. Any resolution failure (unreadable foreign
    // dataDir) degrades to unknown_session below — never to silence (I3).
    const foreignSessionIndex = new Map<
      string,
      { agent: AgentName; worktreePath: string; terminal: boolean }
    >();
    for (const foreignDir of options?.resolveForeignDataDirs?.() ?? []) {
      let foreignSessions: ReturnType<typeof listSessions>;
      try {
        foreignSessions = listSessions(foreignDir);
      } catch {
        continue;
      }
      for (const foreignSession of foreignSessions) {
        const candidate = {
          agent: foreignSession.agent,
          worktreePath: foreignSession.worktreePath,
          terminal: foreignSession.status === "completed" || foreignSession.status === "killed",
        };
        const existing = foreignSessionIndex.get(foreignSession.id);
        // Deterministic terminal-wins precedence: the same sessionId can
        // exist in more than one resolved foreign dataDir with different
        // statuses, and iteration order must never decide the outcome. A
        // terminal record always wins over a non-terminal one regardless of
        // which was seen first — fail-safe direction, consistent with I3
        // (any ambiguity degrades toward unknown_session/warn, never toward
        // silence). Among records of equal terminality, first-seen wins.
        if (!existing || (candidate.terminal && !existing.terminal)) {
          foreignSessionIndex.set(foreignSession.id, candidate);
        }
      }
    }

    for (const { sessionId, roots } of recordless) {
      const foreignRecord = foreignSessionIndex.get(sessionId);
      // A terminal foreign record (completed/killed) proves the process it
      // once belonged to should be gone — a survivor is still a leak, never
      // downgraded to foreign_instance just because its record lives in
      // another instance's dataDir.
      for (const proc of roots) {
        if (foreignRecord && !foreignRecord.terminal) {
          findings.push(
            toFinding(
              proc,
              sessionId,
              foreignRecord.agent,
              foreignRecord.worktreePath,
              "foreign_instance",
            ),
          );
          continue;
        }
        const cwd = await readProcessCwd(proc.pid);
        const agent = resolveAgentForArgs(proc.args, compiledMatchers);
        findings.push(toFinding(proc, sessionId, agent, cwd ?? "", "unknown_session"));
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
  // Lazy: resolveRegisteredDataDirs parses every registered config file
  // (measured 55.4ms across 13 paths on a live host). scanUnownedAgentProcesses
  // only calls this thunk when at least one process is actually record-less,
  // so a clean host pays zero extra config parses.
  const scan = await scanUnownedAgentProcesses(dataDir, {
    resolveForeignDataDirs: () => resolveRegisteredDataDirs(dataDir),
  });
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
  const nonForeign = scan.processes.filter((proc) => proc.reason !== "foreign_instance");
  if (nonForeign.length === 0) {
    return {
      id: "agent-process-ownership",
      ok: true,
      severity: "info",
      detail: `${scan.processes.length} live agent process(es) belong to another registered instance (foreign_instance)`,
    };
  }
  const lines = nonForeign.map(
    (proc) =>
      `pid ${proc.pid} agent ${proc.agent ?? "unknown"} session ${proc.sessionId} reason ${proc.reason} rss ${(proc.rssKb / 1024).toFixed(1)}MB age ${formatAge(proc.elapsedSeconds)} worktree ${proc.worktreePath || "unknown"}`,
  );
  return {
    id: "agent-process-ownership",
    ok: false,
    severity: "warn",
    detail: `${nonForeign.length} unowned agent process(es) found:\n${lines.join("\n")}`,
  };
}
