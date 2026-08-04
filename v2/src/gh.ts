import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { logSpurEvent } from "./event-log.js";

const execFileAsync = promisify(execFile);

const WHICH_PATH = "/usr/bin/which";

type GhPathState =
  | { status: "resolved"; path: string }
  | { status: "unavailable"; message: string };

let cachedGhPathState: GhPathState | null = null;

async function resolveGhPathFromPath(): Promise<GhPathState> {
  try {
    const { stdout } = await execFileAsync(WHICH_PATH, ["gh"], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const path = stdout.trim();
    if (!path.startsWith("/")) {
      return { status: "unavailable", message: "gh not found on PATH" };
    }
    return { status: "resolved", path };
  } catch {
    return { status: "unavailable", message: "gh not found on PATH" };
  }
}

export async function initializeGhPath(): Promise<GhPathState> {
  cachedGhPathState = await resolveGhPathFromPath();
  return cachedGhPathState;
}

async function resolveGhPath(): Promise<string> {
  const state = cachedGhPathState ?? (await initializeGhPath());
  if (state.status === "unavailable") {
    throw new Error(state.message);
  }
  return state.path;
}

export function _resetGhPathCacheForTests(): void {
  cachedGhPathState = null;
}

export function extractGithubErrorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  } else if (typeof error === "string") {
    parts.push(error);
  }
  if (typeof error === "object" && error !== null) {
    if ("stderr" in error && typeof error.stderr === "string") {
      parts.push(error.stderr);
    }
    if ("stdout" in error && typeof error.stdout === "string") {
      parts.push(error.stdout);
    }
    if (!("message" in error) && parts.length === 0) {
      parts.push(String(error));
    }
  }
  return parts.join("\n").trim() || String(error);
}

export function isGitHubRateLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("api rate limit already exceeded") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("secondary rate limit") ||
    (lower.includes("http 403") && lower.includes("rate limit"))
  );
}

// ---------------------------------------------------------------------------
// gh invocation accounting and GraphQL budget ledger.
//
// gh() is the process's sole gh spawner, so one counter here covers the review
// providers, both event sources and the PR discovery path. The ledger is
// observation-only: it is fed by rate-limit blocks GitHub already returned and
// by the rateLimit block that rides inside batched GraphQL responses. Nothing
// here ever probes `gh api rate_limit`, and gh() never refuses a call — only
// the poll path consults `pollBudgetState()`.
// ---------------------------------------------------------------------------

const GH_USAGE_MINUTE_MS = 60_000;
const GH_USAGE_HOUR_MS = 60 * 60_000;
const GH_USAGE_MAX_SUBCOMMAND_KEYS = 20;
const GH_USAGE_OTHER_KEY = "other";
// 20% of the shared 5000/hr GraphQL budget stays reserved for interactive
// agents; the daemon's poll path stops issuing lookups below it.
export const GH_POLL_MIN_GRAPHQL_REMAINING = 1000;
// Same reactive cooldown shape as the GitHub event source: 5min doubling to
// 60min per consecutive rate-limit block.
const GH_RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60_000;
const GH_RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60_000;

let ghEventSinkDataDir: string | null = null;

/**
 * Points gh accounting at a dataDir so it can append to events.jsonl. Left
 * unset in CLI processes, where no emission is the correct behavior.
 */
export function setGhEventSink(dataDir: string | null): void {
  ghEventSinkDataDir = dataDir;
}

interface GhUsageWindow {
  startedAt: number;
  calls: number;
  bySubcommand: Map<string, number>;
}

interface GraphqlBudgetLedger {
  remaining: number | null;
  resetAtMs: number | null;
  observedAtMs: number | null;
  hits: number;
  blockedUntilMs: number | null;
}

let minuteWindow: GhUsageWindow | null = null;
let hourWindow: GhUsageWindow | null = null;
let budget: GraphqlBudgetLedger = {
  remaining: null,
  resetAtMs: null,
  observedAtMs: null,
  hits: 0,
  blockedUntilMs: null,
};
let lastPausedEventKey: string | null = null;

export function _resetGhUsageForTests(): void {
  minuteWindow = null;
  hourWindow = null;
  budget = {
    remaining: null,
    resetAtMs: null,
    observedAtMs: null,
    hits: 0,
    blockedUntilMs: null,
  };
  lastPausedEventKey = null;
  ghEventSinkDataDir = null;
}

function subcommandKey(args: string[]): string {
  const first = args[0];
  if (!first || first.startsWith("-")) {
    return GH_USAGE_OTHER_KEY;
  }
  const second = args[1];
  if (!second || second.startsWith("-")) {
    return first;
  }
  return `${first} ${second}`;
}

function countSubcommand(window: GhUsageWindow, key: string): void {
  const existing = window.bySubcommand.get(key);
  if (existing !== undefined) {
    window.bySubcommand.set(key, existing + 1);
    return;
  }
  // Cardinality ceiling: unknown shapes past the cap fold into "other" so a
  // long-running daemon cannot grow the details object without bound. One slot
  // is reserved for "other" itself, so the map never exceeds the cap.
  const bucket =
    window.bySubcommand.size >= GH_USAGE_MAX_SUBCOMMAND_KEYS - 1 ? GH_USAGE_OTHER_KEY : key;
  window.bySubcommand.set(bucket, (window.bySubcommand.get(bucket) ?? 0) + 1);
}

function emitUsageWindow(window: GhUsageWindow, label: "minute" | "hour", nowMs: number): void {
  const dataDir = ghEventSinkDataDir;
  if (!dataDir) {
    return;
  }
  const windowMs = nowMs - window.startedAt;
  logSpurEvent(dataDir, {
    event: "gh.usage",
    level: "info",
    message: `gh invoked ${window.calls} times in the last ${label === "minute" ? "60s" : "60m"}`,
    details: {
      window: label,
      windowMs,
      calls: window.calls,
      bySubcommand: Object.fromEntries(window.bySubcommand),
      graphqlRemaining: budget.remaining,
    },
  });
}

/**
 * Counts one gh invocation and lazily flushes a completed window. Emission is
 * driven by invocations only, never by a timer, so an idle daemon writes
 * nothing: at most one minute event per 60s and one hour event per 3600s.
 */
export function noteGhInvocation(args: string[], nowMs: number = Date.now()): void {
  const key = subcommandKey(args);
  if (minuteWindow && nowMs - minuteWindow.startedAt >= GH_USAGE_MINUTE_MS) {
    emitUsageWindow(minuteWindow, "minute", nowMs);
    minuteWindow = null;
  }
  if (hourWindow && nowMs - hourWindow.startedAt >= GH_USAGE_HOUR_MS) {
    emitUsageWindow(hourWindow, "hour", nowMs);
    hourWindow = null;
  }
  if (!minuteWindow) {
    minuteWindow = { startedAt: nowMs, calls: 0, bySubcommand: new Map() };
  }
  if (!hourWindow) {
    hourWindow = { startedAt: nowMs, calls: 0, bySubcommand: new Map() };
  }
  minuteWindow.calls += 1;
  hourWindow.calls += 1;
  countSubcommand(minuteWindow, key);
  countSubcommand(hourWindow, key);
}

/**
 * Records the `rateLimit` block that rides inside a GraphQL response. Free:
 * no extra request. An observation at or above the floor clears the reactive
 * cooldown, which is the only thing that resets `hits`.
 */
export function recordGraphqlBudget(
  remaining: number,
  resetAtMs: number | null,
  nowMs: number = Date.now(),
): void {
  budget.remaining = remaining;
  budget.resetAtMs = resetAtMs;
  budget.observedAtMs = nowMs;
  if (remaining >= GH_POLL_MIN_GRAPHQL_REMAINING) {
    budget.hits = 0;
    budget.blockedUntilMs = null;
  }
}

/**
 * Records a rate-limit block observed on any gh call in this process and opens
 * an exponential cooldown for the poll path.
 */
export function noteGitHubRateLimitHit(nowMs: number = Date.now()): void {
  budget.hits += 1;
  const backoff = Math.min(
    GH_RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (budget.hits - 1),
    GH_RATE_LIMIT_BACKOFF_MAX_MS,
  );
  budget.blockedUntilMs = nowMs + backoff;
}

export type GhPollBudgetState =
  | { blocked: false }
  | {
      blocked: true;
      reason: "cooldown" | "remaining";
      remaining: number | null;
      resetAt: string | null;
    };

/**
 * Whether the daemon's poll path may spend GraphQL budget right now. Read at
 * flush time by the PR discovery path only.
 */
export function pollBudgetState(nowMs: number = Date.now()): GhPollBudgetState {
  if (budget.resetAtMs !== null && nowMs >= budget.resetAtMs) {
    // The rate-limit window rolled over. Drop the stale observation and the
    // cooldown without probing; `hits` survives so a repeat exhaustion keeps
    // climbing the backoff until a healthy observation clears it.
    budget.remaining = null;
    budget.resetAtMs = null;
    budget.observedAtMs = null;
    budget.blockedUntilMs = null;
  }
  if (budget.blockedUntilMs !== null) {
    if (nowMs < budget.blockedUntilMs) {
      return blockedState("cooldown", `cooldown:${budget.blockedUntilMs}`);
    }
    budget.blockedUntilMs = null;
  }
  if (budget.remaining !== null && budget.remaining < GH_POLL_MIN_GRAPHQL_REMAINING) {
    return blockedState("remaining", `remaining:${budget.resetAtMs ?? budget.observedAtMs ?? 0}`);
  }
  return { blocked: false };
}

function blockedState(reason: "cooldown" | "remaining", eventKey: string): GhPollBudgetState {
  const resetAt = budget.resetAtMs === null ? null : new Date(budget.resetAtMs).toISOString();
  if (ghEventSinkDataDir && lastPausedEventKey !== eventKey) {
    lastPausedEventKey = eventKey;
    logSpurEvent(ghEventSinkDataDir, {
      event: "gh.poll_budget_paused",
      level: "warn",
      message: `GitHub poll lookups paused (${reason})`,
      details: { remaining: budget.remaining, resetAt },
    });
  }
  return { blocked: true, reason, remaining: budget.remaining, resetAt };
}

export async function gh(cwd: string, ...args: string[]): Promise<string> {
  noteGhInvocation(args);
  const path = await resolveGhPath();
  try {
    const { stdout } = await execFileAsync(path, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (isGitHubRateLimitError(extractGithubErrorText(error))) {
      // Any gh call anywhere in the process teaches the ledger that the shared
      // budget is exhausted, so the poll path backs off even when the block was
      // observed by a review-source call.
      noteGitHubRateLimitHit();
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      // ENOENT is ambiguous: execFile throws it for a missing gh binary AND a
      // missing cwd. A transient/removed worktree must not poison the shared
      // path cache and kill the source until restart — fail only this call.
      if (!existsSync(cwd)) {
        throw new Error(`gh cwd does not exist: ${cwd}`, { cause: error });
      }
      cachedGhPathState = {
        status: "unavailable",
        message: `gh unavailable: resolved gh at ${path} is no longer executable; restart Spur daemon after fixing PATH`,
      };
      throw new Error(cachedGhPathState.message, { cause: error });
    }
    throw error;
  }
}
