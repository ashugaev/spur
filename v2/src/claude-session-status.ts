import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { SessionState } from "./types.js";
import { resolveWorktreePathCandidates } from "./agents/worktree-path.js";
import { canReadProcessTree, classifyProcessOwnership, type PpidReader } from "./process-tree.js";

export interface ClaudeSessionStatusRecord {
  state: SessionState;
  filePath: string;
  status: string;
  updatedMs: number;
  cwd?: string;
  sessionId?: string;
  waitingFor?: string;
  pid?: number;
}

export interface ReadClaudeSessionStatusOptions {
  // Pid of the session's tmux pane. When set and process ancestry is
  // introspectable, only status files written by a process inside that pane's
  // tree are trusted — this is the sole key unique to the tracked process.
  panePid?: number;
  readPpid?: PpidReader;
}

type ClaudeSessionStatusCandidate = Omit<ClaudeSessionStatusRecord, "state">;

export function classifyClaudeSessionStatus(
  status: string,
  waitingFor?: string,
): SessionState | null {
  if (status === "busy") {
    return "working";
  }
  if (status === "idle") {
    return "waiting";
  }
  if (status !== "waiting") {
    return null;
  }
  if (waitingFor === undefined) {
    return "waiting";
  }
  return waitingFor === "permission prompt" ? "needs_input" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readWaitingFor(parsed: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(parsed, "waitingFor")) {
    return undefined;
  }
  return typeof parsed["waitingFor"] === "string" ? parsed["waitingFor"] : "";
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }
  return null;
}

function extractUpdatedMs(parsed: Record<string, unknown>, fileMtimeMs: number): number {
  const candidates = [
    parsed["statusUpdated"],
    parsed["statusUpdatedAt"],
    parsed["updated"],
    parsed["updatedAt"],
  ];
  const timestamps = candidates
    .map((candidate) => readTimestampMs(candidate))
    .filter((timestamp): timestamp is number => timestamp !== null);
  return timestamps.length > 0 ? Math.max(...timestamps) : fileMtimeMs;
}

function extractCandidate(
  parsed: unknown,
  filePath: string,
  fileMtimeMs: number,
): ClaudeSessionStatusCandidate | null {
  if (!isRecord(parsed)) {
    return null;
  }
  const status = readString(parsed["status"]);
  if (!status) {
    return null;
  }
  const cwd = readString(parsed["cwd"]);
  const sessionId = readString(parsed["sessionId"]);
  const waitingFor = readWaitingFor(parsed);
  const pid = readPid(parsed["pid"]);
  return {
    filePath,
    status,
    updatedMs: extractUpdatedMs(parsed, fileMtimeMs),
    ...(cwd ? { cwd } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(waitingFor !== undefined ? { waitingFor } : {}),
    ...(pid !== undefined ? { pid } : {}),
  };
}

function readPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function matchesSession(
  candidate: ClaudeSessionStatusCandidate,
  worktreePaths: Set<string>,
  agentSessionId?: string,
): boolean {
  if (agentSessionId && candidate.sessionId === agentSessionId) {
    return true;
  }
  return candidate.cwd ? worktreePaths.has(resolvePath(candidate.cwd)) : false;
}

async function filterByPaneTree(
  candidates: ClaudeSessionStatusCandidate[],
  options: ReadClaudeSessionStatusOptions,
): Promise<ClaudeSessionStatusCandidate[]> {
  const { panePid, readPpid } = options;
  if (panePid === undefined || panePid <= 0 || candidates.length === 0) {
    return candidates;
  }
  // Without procfs we cannot tell whose process owns a file; filtering would be
  // a false negative, so keep the weaker-keyed candidates unchanged.
  if (!(await canReadProcessTree(panePid, readPpid))) {
    return candidates;
  }
  const verdicts = await Promise.all(
    candidates.map((candidate) =>
      candidate.pid === undefined
        ? Promise.resolve("unknown" as const)
        : classifyProcessOwnership(candidate.pid, panePid, readPpid),
    ),
  );
  const owned = candidates.filter((_, index) => verdicts[index] === "owned");
  if (owned.length > 0) {
    return owned;
  }
  // Nothing is confidently owned. Drop confirmed strangers (the collision this
  // guards against) but keep unresolvable/pid-less files: a session's own final
  // status, or one racing a fork, must not be silently discarded.
  return candidates.filter((_, index) => verdicts[index] === "unknown");
}

async function readCandidate(filePath: string): Promise<ClaudeSessionStatusCandidate | null> {
  try {
    const fileStat = await stat(filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return extractCandidate(parsed, filePath, fileStat.mtimeMs);
  } catch {
    return null;
  }
}

export async function readClaudeSessionStatus(
  worktreePath: string,
  agentSessionId?: string,
  sessionsDir = join(homedir(), ".claude", "sessions"),
  options: ReadClaudeSessionStatusOptions = {},
): Promise<ClaudeSessionStatusRecord | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const worktreePaths = new Set(
    (await resolveWorktreePathCandidates(worktreePath)).map((candidate) => resolvePath(candidate)),
  );
  let candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readCandidate(join(sessionsDir, entry))),
    )
  ).filter(
    (candidate): candidate is ClaudeSessionStatusCandidate =>
      candidate !== null && matchesSession(candidate, worktreePaths, agentSessionId),
  );

  // cwd and sessionId both collide across shared workspaces and resumed
  // processes, so a stranger's status file can outrank the tracked one. When
  // the pane pid is known and ancestry is introspectable, keep only files
  // owned by the pane's own process tree — the one key that is unique.
  candidates = await filterByPaneTree(candidates, options);

  candidates.sort((left, right) => right.updatedMs - left.updatedMs);

  const latest = candidates[0];
  if (!latest) {
    return null;
  }
  const state = classifyClaudeSessionStatus(latest.status, latest.waitingFor);
  if (!state) {
    return null;
  }
  return {
    ...latest,
    state,
  };
}
