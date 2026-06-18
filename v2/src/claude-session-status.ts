import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { SessionState } from "./types.js";
import { resolveWorktreePathCandidates } from "./agents/worktree-path.js";

export interface ClaudeSessionStatusRecord {
  state: SessionState;
  filePath: string;
  status: string;
  updatedMs: number;
  cwd?: string;
  sessionId?: string;
  waitingFor?: string;
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
  return {
    filePath,
    status,
    updatedMs: extractUpdatedMs(parsed, fileMtimeMs),
    ...(cwd ? { cwd } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(waitingFor !== undefined ? { waitingFor } : {}),
  };
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
  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readCandidate(join(sessionsDir, entry))),
    )
  ).filter(
    (candidate): candidate is ClaudeSessionStatusCandidate =>
      candidate !== null && matchesSession(candidate, worktreePaths, agentSessionId),
  );
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
