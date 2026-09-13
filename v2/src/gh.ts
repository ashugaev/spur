import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
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
const GH_USAGE_OTHER_KEY = "other";
// The observation window is at most this stale before it is dropped. GitHub's
// GraphQL budget refills on a 60min rolling window, and a response that carried
// no parseable `resetAt` gives no other way to learn that its `remaining`
// reading has expired — without this bound such a reading would pause the poll
// path until the daemon restarted.
const GH_BUDGET_OBSERVATION_MAX_AGE_MS = 60 * 60_000;
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
  /** GraphQL points spent in the window, as billed by GitHub's `rateLimit.cost`. */
  graphqlCost: number;
  bySubcommand: Map<string, number>;
  pendingGraphql: number;
  closedAtMs: number | null;
}

export type GhPollCycleKind = "attention" | "github_source";

interface GhPollCycleContext {
  kind: GhPollCycleKind;
  startedAt: number;
  calls: number;
  graphqlCost: number;
  bySubcommand: Map<string, number>;
  projectId?: string;
  sourceId?: string;
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
let minuteNextEmissionAtMs = 0;
let hourNextEmissionAtMs = 0;
const closedMinuteWindows: GhUsageWindow[] = [];
const closedHourWindows: GhUsageWindow[] = [];
interface GhGraphqlAttribution {
  startedAt: number;
  minute: GhUsageWindow;
  hour: GhUsageWindow;
  cycle: GhPollCycleContext | undefined;
}
const pendingGraphqlAttributions: GhGraphqlAttribution[] = [];
let budget: GraphqlBudgetLedger = {
  remaining: null,
  resetAtMs: null,
  observedAtMs: null,
  hits: 0,
  blockedUntilMs: null,
};
let lastPausedEventKey: string | null = null;
// A key whose source is removed from the config stops polling and would
// otherwise sit in pollCycleRuns for the daemon's lifetime, so an entry
// untouched for this long is flushed and dropped; the next cycle on that key
// simply opens a fresh run.
const POLL_CYCLE_RUN_MAX_IDLE_MS = 60 * 60_000;
// Rollup window for gh.poll_cycle. Deliberately not a config key and
// deliberately not equal to any configured poll interval (60_000 or 600_000
// on the live host) — an interval-sized window makes emission cadence
// drift-dependent on the source's own tick.
const GH_POLL_CYCLE_ROLLUP_MS = 900_000;

interface GhPollCycleRun {
  kind: GhPollCycleKind;
  projectId?: string;
  sourceId?: string;
  windowStartedAtMs: number;
  touchedAtMs: number;
  cycles: number;
  zeroCycles: number;
  calls: number;
  graphqlCost: number;
  bySubcommand: Map<string, number>;
  errors: number;
}

const pollCycleRuns = new Map<string, GhPollCycleRun>();

function emptyPollCycleRun(
  kind: GhPollCycleKind,
  projectId: string | undefined,
  sourceId: string | undefined,
  nowMs: number,
): GhPollCycleRun {
  return {
    kind,
    ...(projectId ? { projectId } : {}),
    ...(sourceId ? { sourceId } : {}),
    windowStartedAtMs: nowMs,
    touchedAtMs: nowMs,
    cycles: 0,
    zeroCycles: 0,
    calls: 0,
    graphqlCost: 0,
    bySubcommand: new Map(),
    errors: 0,
  };
}

/**
 * Closes a run's current window: emits an aggregate only if the window spent
 * something (calls > 0, graphqlCost > 0, or a cycle in it threw) then resets
 * the accumulators and stamps a fresh windowStartedAtMs. A window that spent
 * nothing AND threw nothing emits nothing and leaves the run's counters
 * untouched, so they carry into the next window — this is what keeps PR
 * 729's idle-host suppression intact under rollup: window expiry alone must
 * never produce an event. Errors are in the gate, not just the payload —
 * NOT for a failing `gh` call itself: `noteGhInvocation` runs before the
 * call executes, so any `gh()` failure already sets calls > 0 and is
 * already covered by that leg. The `errors` leg covers a cycle whose task
 * throws before ever invoking `gh` (e.g. a local read failing while
 * building the poll's session list) — rare, but such a cycle would
 * otherwise be invisible: zero calls, zero cost, yet it did something that
 * failed and is worth surfacing once per window instead of silently.
 */
function flushPollCycleRun(dataDir: string, run: GhPollCycleRun, nowMs: number): void {
  const spentSomething = run.calls > 0 || run.graphqlCost > 0 || run.errors > 0;
  if (!spentSomething) {
    return;
  }
  logSpurEvent(dataDir, {
    event: "gh.poll_cycle",
    level: "info",
    ...(run.projectId ? { projectId: run.projectId } : {}),
    ...(run.sourceId ? { sourceId: run.sourceId } : {}),
    message: `gh invoked ${run.calls} times across ${run.cycles} ${run.kind} poll cycles`,
    details: {
      cycle: run.kind,
      windowMs: nowMs - run.windowStartedAtMs,
      cycles: run.cycles,
      zeroCycles: run.zeroCycles,
      calls: run.calls,
      graphqlCost: run.graphqlCost,
      bySubcommand: Object.fromEntries(run.bySubcommand),
      ...(run.errors > 0 ? { errors: run.errors } : {}),
    },
  });
  run.cycles = 0;
  run.zeroCycles = 0;
  run.calls = 0;
  run.graphqlCost = 0;
  run.bySubcommand = new Map();
  run.errors = 0;
  run.windowStartedAtMs = nowMs;
}

/**
 * Flushes and drops every run untouched for longer than the idle ceiling. A
 * paying window is flushed through the same zero-cost gate as any other close
 * (so its cost is never dropped); a zero-cost window emits nothing, matching
 * today's zeroCycleRuns idle-drop behavior.
 */
function prunePollCycleRuns(nowMs: number): void {
  const dataDir = ghEventSinkDataDir;
  for (const [key, run] of pollCycleRuns) {
    if (nowMs - run.touchedAtMs > POLL_CYCLE_RUN_MAX_IDLE_MS) {
      if (dataDir) flushPollCycleRun(dataDir, run, nowMs);
      pollCycleRuns.delete(key);
    }
  }
}

/**
 * Flushes every open run at shutdown, so a paying window mid-rollup is never
 * lost. Deletes each entry after flushing — mirrors flushCollapseEntry
 * (event-log.ts) and rules out a double-emit if the process somehow polled
 * again after this ran.
 */
export function flushGhPollCycles(): void {
  const dataDir = ghEventSinkDataDir;
  const nowMs = Date.now();
  for (const [key, run] of pollCycleRuns) {
    if (dataDir) flushPollCycleRun(dataDir, run, nowMs);
    pollCycleRuns.delete(key);
  }
}
const ghPollCycleStorage = new AsyncLocalStorage<GhPollCycleContext>();
let ghPollAdmissionTail: Promise<void> = Promise.resolve();

export function _resetGhUsageForTests(): void {
  minuteWindow = null;
  hourWindow = null;
  minuteNextEmissionAtMs = 0;
  hourNextEmissionAtMs = 0;
  closedMinuteWindows.length = 0;
  closedHourWindows.length = 0;
  pendingGraphqlAttributions.length = 0;
  budget = {
    remaining: null,
    resetAtMs: null,
    observedAtMs: null,
    hits: 0,
    blockedUntilMs: null,
  };
  lastPausedEventKey = null;
  pollCycleRuns.clear();
  ghEventSinkDataDir = null;
  ghPollAdmissionTail = Promise.resolve();
}

// Fixed key set. A gh argv must never be able to invent a key: the REST paths
// the review providers build (`api repos/<owner>/<repo>/pulls/<n>/reviews?page=2`)
// are unique per PR per page, and letting them through would bury the one key
// that matters — `api graphql` — under thousands of one-shot keys.
const GH_USAGE_COMMANDS = new Set([
  "alias",
  "api",
  "auth",
  "browse",
  "cache",
  "codespace",
  "config",
  "extension",
  "gist",
  "issue",
  "label",
  "org",
  "pr",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "status",
  "variable",
  "workflow",
]);
const GH_USAGE_SUBCOMMANDS = new Set([
  "cancel",
  "checks",
  "clone",
  "close",
  "code",
  "comment",
  "commits",
  "create",
  "delete",
  "diff",
  "download",
  "edit",
  "get",
  "issues",
  "list",
  "login",
  "logout",
  "merge",
  "prs",
  "ready",
  "refresh",
  "reopen",
  "repos",
  "rerun",
  "set",
  "set-default",
  "status",
  "token",
  "upload",
  "view",
  "watch",
]);

function subcommandKey(args: string[]): string {
  const first = args[0];
  if (!first || !GH_USAGE_COMMANDS.has(first)) {
    return GH_USAGE_OTHER_KEY;
  }
  const second = args[1];
  if (first === "api") {
    // The GraphQL budget and the REST budget are separate ceilings, so the two
    // shapes are separate keys — and neither carries the path.
    return args.includes("graphql") ? "api graphql" : "api rest";
  }
  if (!second || !GH_USAGE_SUBCOMMANDS.has(second)) {
    return first;
  }
  return `${first} ${second}`;
}

function countSubcommand(window: { bySubcommand: Map<string, number> }, key: string): void {
  window.bySubcommand.set(key, (window.bySubcommand.get(key) ?? 0) + 1);
}

function drainClosedUsageWindows(label: "minute" | "hour", nowMs: number): void {
  const queue = label === "minute" ? closedMinuteWindows : closedHourWindows;
  const nextEmissionAtMs = label === "minute" ? minuteNextEmissionAtMs : hourNextEmissionAtMs;
  const window = queue[0];
  if (!window || window.pendingGraphql > 0 || nowMs < nextEmissionAtMs) return;
  emitUsageWindow(window, label, nowMs);
  queue.shift();
  if (label === "minute") {
    minuteNextEmissionAtMs = nowMs + GH_USAGE_MINUTE_MS;
  } else {
    hourNextEmissionAtMs = nowMs + GH_USAGE_HOUR_MS;
  }
}

function closeUsageWindow(window: GhUsageWindow, label: "minute" | "hour", nowMs: number): void {
  if (window.closedAtMs === null) {
    window.closedAtMs = nowMs;
    const queue = label === "minute" ? closedMinuteWindows : closedHourWindows;
    queue.push(window);
    queue.sort((left, right) => left.startedAt - right.startedAt);
  }
  drainClosedUsageWindows(label, nowMs);
}

function pollCycleKey(cycle: GhPollCycleContext): string {
  return `${cycle.kind} ${cycle.projectId ?? ""} ${cycle.sourceId ?? ""}`;
}

/**
 * Runs one daemon poll boundary and accounts its exact gh cost.
 *
 * The first cycle ever seen for a key emits immediately (unconditionally,
 * whether or not it spent anything) and opens a rollup window. Every later
 * cycle inside GH_POLL_CYCLE_ROLLUP_MS accumulates into that window without
 * writing anything; the first cycle at or past the window boundary closes it
 * through flushPollCycleRun, which emits one aggregate event summing the
 * window IF it spent something, or emits nothing and carries the counters
 * forward if the whole window was zero-cost. That gate is what keeps PR 729's
 * idle-host suppression intact under rollup — window expiry alone never
 * produces an event.
 */
export async function runGhPollCycle<T>(
  input: { kind: GhPollCycleKind; projectId?: string; sourceId?: string },
  task: () => Promise<T>,
): Promise<T> {
  const cycle: GhPollCycleContext = {
    kind: input.kind,
    startedAt: Date.now(),
    calls: 0,
    graphqlCost: 0,
    bySubcommand: new Map(),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  };
  let cycleFailed = false;
  try {
    return await ghPollCycleStorage.run(cycle, task);
  } catch (error) {
    cycleFailed = true;
    throw error;
  } finally {
    const dataDir = ghEventSinkDataDir;
    const endedAtMs = Date.now();
    const key = pollCycleKey(cycle);
    prunePollCycleRuns(endedAtMs);
    const existingRun = pollCycleRuns.get(key);
    if (!existingRun) {
      // Without a sink there is nowhere to ever flush a run to, so no run is
      // opened: registering one anyway would start its windowStartedAtMs
      // clock on a cycle nobody logged (a phantom span once a sink is later
      // set) and, in a process that never sets one at all (e.g. the CLI),
      // would accumulate an entry per key for the life of the process. This
      // standalone event is the only window this cycle ever belongs to, so a
      // failure is reported on it directly via the details.errors field.
      if (dataDir) {
        logSpurEvent(dataDir, {
          event: "gh.poll_cycle",
          level: "info",
          ...(cycle.projectId ? { projectId: cycle.projectId } : {}),
          ...(cycle.sourceId ? { sourceId: cycle.sourceId } : {}),
          message: `gh invoked ${cycle.calls} times in ${cycle.kind} poll cycle`,
          details: {
            cycle: cycle.kind,
            durationMs: endedAtMs - cycle.startedAt,
            calls: cycle.calls,
            graphqlCost: cycle.graphqlCost,
            bySubcommand: Object.fromEntries(cycle.bySubcommand),
            ...(cycleFailed ? { errors: 1 } : {}),
          },
        });
        // The run's own cycles/errors counters start clean: this first cycle
        // was just emitted standalone above (already carrying its own
        // failure, if any), so seeding it into the run would attribute it to
        // a window that never actually counted this cycle as one of its own.
        pollCycleRuns.set(
          key,
          emptyPollCycleRun(cycle.kind, cycle.projectId, cycle.sourceId, endedAtMs),
        );
      }
    } else {
      existingRun.touchedAtMs = endedAtMs;
      existingRun.cycles += 1;
      if (cycle.calls === 0 && cycle.graphqlCost === 0) {
        existingRun.zeroCycles += 1;
      }
      existingRun.calls += cycle.calls;
      existingRun.graphqlCost += cycle.graphqlCost;
      for (const [subcommand, count] of cycle.bySubcommand) {
        existingRun.bySubcommand.set(
          subcommand,
          (existingRun.bySubcommand.get(subcommand) ?? 0) + count,
        );
      }
      if (cycleFailed) existingRun.errors += 1;
      if (dataDir && endedAtMs - existingRun.windowStartedAtMs >= GH_POLL_CYCLE_ROLLUP_MS) {
        flushPollCycleRun(dataDir, existingRun, endedAtMs);
      }
    }
  }
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
      graphqlCost: window.graphqlCost,
      bySubcommand: Object.fromEntries(window.bySubcommand),
      graphqlRemaining: budget.remaining,
    },
  });
}

/**
 * Emits whatever is accumulated right now and starts fresh. Windows are
 * otherwise flushed lazily by the next invocation, which loses exactly the
 * window that matters when the daemon goes quiet or the budget gate pauses
 * lookups — the hour in which the budget was exhausted.
 */
function flushUsageWindows(nowMs: number): void {
  if (minuteWindow && nowMs >= minuteNextEmissionAtMs) {
    closeUsageWindow(minuteWindow, "minute", nowMs);
    minuteWindow = null;
  }
  if (hourWindow && nowMs >= hourNextEmissionAtMs) {
    closeUsageWindow(hourWindow, "hour", nowMs);
    hourWindow = null;
  }
  drainClosedUsageWindows("minute", nowMs);
  drainClosedUsageWindows("hour", nowMs);
}

/**
 * Adds GitHub's billed GraphQL points to the windows that admitted the call.
 * Cost, not calls, is what the 5000/hr ceiling counts.
 */
export function noteGraphqlCost(
  points: number,
  attributionAtMs: number = Date.now(),
  completedAtMs: number = attributionAtMs,
): void {
  const cycle = ghPollCycleStorage.getStore();
  let attributionIndex = -1;
  let attributionDistance = Number.POSITIVE_INFINITY;
  for (const [index, candidate] of pendingGraphqlAttributions.entries()) {
    if (candidate.cycle !== cycle) continue;
    const distance = Math.abs(candidate.startedAt - attributionAtMs);
    if (distance < attributionDistance) {
      attributionIndex = index;
      attributionDistance = distance;
    }
  }
  const attribution =
    attributionIndex >= 0 ? pendingGraphqlAttributions.splice(attributionIndex, 1)[0] : undefined;
  if (attribution) {
    attribution.minute.pendingGraphql -= 1;
    attribution.hour.pendingGraphql -= 1;
    if (Number.isFinite(points) && points > 0) {
      attribution.minute.graphqlCost += points;
      attribution.hour.graphqlCost += points;
      if (attribution.cycle) attribution.cycle.graphqlCost += points;
    }
    if (attribution.minute.closedAtMs !== null) {
      closeUsageWindow(attribution.minute, "minute", completedAtMs);
    }
    if (attribution.hour.closedAtMs !== null) {
      closeUsageWindow(attribution.hour, "hour", completedAtMs);
    }
    return;
  }
  if (!Number.isFinite(points) || points <= 0) return;
  if (minuteWindow) {
    minuteWindow.graphqlCost += points;
  }
  if (hourWindow) {
    hourWindow.graphqlCost += points;
  }
  if (cycle) cycle.graphqlCost += points;
}

/**
 * Counts one gh invocation and lazily flushes a completed window. Emission is
 * driven by invocations only, never by a timer, so an idle daemon writes
 * nothing: at most one minute event per 60s and one hour event per 3600s.
 */
export function noteGhInvocation(args: string[], nowMs: number = Date.now()): void {
  const key = subcommandKey(args);
  const cycle = ghPollCycleStorage.getStore();
  if (cycle) {
    cycle.calls += 1;
    countSubcommand(cycle, key);
  }
  if (minuteWindow && nowMs - minuteWindow.startedAt >= GH_USAGE_MINUTE_MS) {
    closeUsageWindow(minuteWindow, "minute", nowMs);
    minuteWindow = null;
  }
  if (hourWindow && nowMs - hourWindow.startedAt >= GH_USAGE_HOUR_MS) {
    closeUsageWindow(hourWindow, "hour", nowMs);
    hourWindow = null;
  }
  if (!minuteWindow) {
    minuteWindow = {
      startedAt: nowMs,
      calls: 0,
      graphqlCost: 0,
      bySubcommand: new Map(),
      pendingGraphql: 0,
      closedAtMs: null,
    };
  }
  if (!hourWindow) {
    hourWindow = {
      startedAt: nowMs,
      calls: 0,
      graphqlCost: 0,
      bySubcommand: new Map(),
      pendingGraphql: 0,
      closedAtMs: null,
    };
  }
  minuteWindow.calls += 1;
  hourWindow.calls += 1;
  countSubcommand(minuteWindow, key);
  countSubcommand(hourWindow, key);
  if (key === "api graphql") {
    minuteWindow.pendingGraphql += 1;
    hourWindow.pendingGraphql += 1;
    pendingGraphqlAttributions.push({
      startedAt: nowMs,
      minute: minuteWindow,
      hour: hourWindow,
      cycle,
    });
  }
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
  const olderObservation = budget.observedAtMs !== null && nowMs < budget.observedAtMs;
  const raisesSameWindow =
    resetAtMs !== null &&
    budget.remaining !== null &&
    budget.resetAtMs === resetAtMs &&
    remaining > budget.remaining;
  if (olderObservation || raisesSameWindow) {
    return;
  }
  budget.remaining = remaining;
  budget.resetAtMs = resetAtMs;
  budget.observedAtMs = nowMs;
  if (remaining >= GH_POLL_MIN_GRAPHQL_REMAINING) {
    budget.hits = 0;
    budget.blockedUntilMs = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordGraphqlBudgetFromEnvelope(
  envelope: unknown,
  observedAtMs: number = Date.now(),
  completedAtMs: number = Date.now(),
): void {
  if (!isRecord(envelope) || !isRecord(envelope["data"])) {
    noteGraphqlCost(0, observedAtMs, completedAtMs);
    return;
  }
  const rateLimit = envelope["data"]["rateLimit"];
  if (!isRecord(rateLimit)) {
    noteGraphqlCost(0, observedAtMs, completedAtMs);
    return;
  }
  const cost = rateLimit["cost"];
  noteGraphqlCost(typeof cost === "number" ? cost : 0, observedAtMs, completedAtMs);
  const remaining = rateLimit["remaining"];
  if (typeof remaining !== "number") return;
  const resetAt = rateLimit["resetAt"];
  const resetAtMs = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
  recordGraphqlBudget(remaining, Number.isFinite(resetAtMs) ? resetAtMs : null, observedAtMs);
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

/**
 * Whether the last `remaining` reading has aged out. `resetAtMs` is the exact
 * answer when GitHub gave one; otherwise the reading is capped by the length of
 * the budget window so a null `resetAt` cannot produce an unclearable block.
 */
function isObservationExpired(nowMs: number): boolean {
  if (budget.resetAtMs !== null) {
    return nowMs >= budget.resetAtMs;
  }
  return (
    budget.observedAtMs !== null && nowMs - budget.observedAtMs >= GH_BUDGET_OBSERVATION_MAX_AGE_MS
  );
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
 * flush time by both PR discovery and batched review polling.
 */
export function pollBudgetState(nowMs: number = Date.now()): GhPollBudgetState {
  if (isObservationExpired(nowMs)) {
    // The rate-limit window rolled over. Drop the stale observation without
    // probing. `blockedUntilMs` is NOT cleared here: a reactive cooldown from
    // `noteGitHubRateLimitHit` is independent of this reading and routinely
    // outlives it — clearing it would throw away the freshest signal there is.
    // `hits` survives too, so a repeat exhaustion keeps climbing the backoff.
    budget.remaining = null;
    budget.resetAtMs = null;
    budget.observedAtMs = null;
  }
  if (budget.blockedUntilMs !== null) {
    if (nowMs < budget.blockedUntilMs) {
      return blockedState("cooldown", `cooldown:${budget.blockedUntilMs}`, nowMs);
    }
    budget.blockedUntilMs = null;
  }
  if (budget.remaining !== null && budget.remaining < GH_POLL_MIN_GRAPHQL_REMAINING) {
    return blockedState(
      "remaining",
      `remaining:${budget.resetAtMs ?? budget.observedAtMs ?? 0}`,
      nowMs,
    );
  }
  return { blocked: false };
}

export type GhPollAdmission<T> =
  | { status: "blocked"; budget: Extract<GhPollBudgetState, { blocked: true }> }
  | { status: "admitted"; value: T };

export async function withGhPollBudget<T>(task: () => Promise<T>): Promise<GhPollAdmission<T>> {
  const previous = ghPollAdmissionTail;
  let release = (): void => {};
  ghPollAdmissionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const current = pollBudgetState();
    return current.blocked
      ? { status: "blocked", budget: current }
      : { status: "admitted", value: await task() };
  } finally {
    release();
  }
}

function blockedState(
  reason: "cooldown" | "remaining",
  eventKey: string,
  nowMs: number,
): GhPollBudgetState {
  const resetAt = budget.resetAtMs === null ? null : new Date(budget.resetAtMs).toISOString();
  if (ghEventSinkDataDir && lastPausedEventKey !== eventKey) {
    lastPausedEventKey = eventKey;
    logSpurEvent(ghEventSinkDataDir, {
      event: "gh.poll_budget_paused",
      level: "warn",
      message: `GitHub poll lookups paused (${reason})`,
      details: { remaining: budget.remaining, resetAt },
    });
    // Land the usage windows that cover the exhaustion instead of waiting for
    // an invocation that the pause itself may prevent.
    flushUsageWindows(nowMs);
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
