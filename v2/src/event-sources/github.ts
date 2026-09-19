import { clearInterval, setInterval as startInterval } from "node:timers";
import { randomUUID } from "node:crypto";
import { logSpurEvent } from "../event-log.js";
import { extractGithubErrorText, gh, isGitHubRateLimitError, runGhPollCycle } from "../gh.js";
import {
  GITHUB_PR_LIFECYCLE_KINDS,
  GITHUB_WORK_ITEM_NEW_EVENT,
  reviewSnapshotBaseline,
  type GitHubCheck,
  type GitHubPrSummary,
  type GitHubSourceConfig,
  type ReviewEventData,
  type ReviewSignal,
  type ReviewSnapshot,
  type SessionRecord,
  type WorkItemEventData,
} from "../types.js";
import {
  isEligibleForSourcePoll,
  type SourceHandle,
  type SourceModule,
  type SourceStartDeps,
} from "./types.js";
import {
  clearGitHubMergeConflictRestoreReplay,
  clearGitHubPollDisabledSession,
  deleteReviewSourceSnapshot,
  hasGitHubMergeConflictRestoreReplay,
  listSessions,
  readGitHubPollDisabled,
  readLifecycleBaselinedSessions,
  readReviewSourceSnapshots,
  readWorkItemRegistry,
  recordGitHubPollDisabledSession,
  recordLifecycleBaselinedSession,
  removeLifecycleBaselinedSession,
  writeGitHubPollDisabled,
  writeReviewSourceSnapshot,
} from "../metadata.js";
import { hasRecentSessionUserAction } from "../user-action-log.js";
import {
  collectGitHubSignalsBatch,
  GitHubReviewBatchError,
  hasTerminalSignal,
} from "../review-providers/github.js";
import { emitWorkItemBacklog } from "./work-item-backlog.js";

export {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolvePrSummary,
  resolveTrackedBranch,
} from "../review-providers/github.js";

export type { GitHubCheck, GitHubPrSummary };

const LIFECYCLE_KINDS = new Set<string>(GITHUB_PR_LIFECYCLE_KINDS);
const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;
// Must exceed the configured eventLog.collapseWindowMs (default 60_000, user-settable
// with no upper bound, config.ts:2109-2110) or the event-log collapse summary/append
// pair returns for a transiently-failing session (event-log.ts:170-183).
const SESSION_POLL_BACKOFF_BASE_MS = 2 * 60 * 1000;
const SESSION_POLL_BACKOFF_MAX_MS = 30 * 60 * 1000;
const ADAPTIVE_ACTIVITY_ACTIONS = new Set(["session.send", "session.source_reply"]);
// After this many consecutive poll failures for the same session, its failures stop
// counting toward the CI-active hysteresis flag (see consecutiveSessionPollErrors).
const CI_HYSTERESIS_ERROR_TOLERANCE = 3;

interface GitHubSearchPrItem {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitHubSearchPrItem(value: unknown): value is GitHubSearchPrItem {
  if (!isRecord(value) || !isRecord(value.repository)) return false;
  return (
    Number.isInteger(value.number) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.repository.nameWithOwner === "string"
  );
}

function parseGitHubSearchPrItems(raw: string): GitHubSearchPrItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid GitHub search PR JSON: ${message}`, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid GitHub search PR JSON: expected an array");
  }

  return parsed.map((item, index) => {
    if (!isGitHubSearchPrItem(item)) {
      throw new Error(`Invalid GitHub search PR item at index ${index}`);
    }
    return item;
  });
}

function isGitHubBadCredentialsError(text: string): boolean {
  return text.toLowerCase().includes("bad credentials");
}

// True only when `text` is unambiguously a "this PR number does not exist" error for
// `prNumber` and nothing else. A pathless envelope error now settles the whole batch
// as one GitHubReviewBatchError (review-providers/github.ts runReviewRepoBatch) whose
// message is shared across every co-batched session; that shared message can still
// name several PR numbers or a PR number belonging to a different session, so this
// predicate must stay this narrow or a healthy co-batched session could be mistaken
// for a dead one.
function isGitHubPermanentNotFoundError(text: string, prNumber: number): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("could not resolve to a") || !lower.includes("pullrequest")) return false;
  if (isGitHubRateLimitError(text) || isGitHubBadCredentialsError(text)) return false;
  const matches = new Set<number>();
  for (const match of text.matchAll(/with the number of (\d+)/g)) {
    matches.add(Number(match[1]));
  }
  return matches.size === 1 && matches.has(prNumber);
}

function parseEpochResetMs(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function parseStringResetMs(value: string): number | null {
  const numeric = Number(value);
  const fromEpoch = parseEpochResetMs(numeric);
  if (fromEpoch !== null) return fromEpoch;
  const fromDate = Date.parse(value);
  return Number.isNaN(fromDate) ? null : fromDate;
}

function findResetMs(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const resetMs = findResetMs(item);
      if (resetMs !== null) return resetMs;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if ("resetAt" in value && typeof value.resetAt === "string") {
    const resetMs = parseStringResetMs(value.resetAt);
    if (resetMs !== null) return resetMs;
  }
  if ("reset_at" in value && typeof value.reset_at === "string") {
    const resetMs = parseStringResetMs(value.reset_at);
    if (resetMs !== null) return resetMs;
  }
  if ("reset" in value) {
    if (typeof value.reset === "number") {
      const resetMs = parseEpochResetMs(value.reset);
      if (resetMs !== null) return resetMs;
    }
    if (typeof value.reset === "string") {
      const resetMs = parseStringResetMs(value.reset);
      if (resetMs !== null) return resetMs;
    }
  }
  if ("x-ratelimit-reset" in value && typeof value["x-ratelimit-reset"] === "string") {
    const resetMs = parseStringResetMs(value["x-ratelimit-reset"]);
    if (resetMs !== null) return resetMs;
  }

  for (const item of Object.values(value)) {
    const resetMs = findResetMs(item);
    if (resetMs !== null) return resetMs;
  }
  return null;
}

function parseResetDeadlineMs(text: string, nowMs: number): number | null {
  const candidates = [
    text.trim(),
    ...text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") || line.startsWith("[")),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const resetMs = findResetMs(parsed);
      if (resetMs !== null && resetMs > nowMs) return resetMs;
    } catch {
      continue;
    }
  }
  return null;
}

function emitSignalsByKind(
  deps: SourceStartDeps<GitHubSourceConfig>,
  data: Omit<ReviewEventData, "signals">,
  signals: ReviewSignal[],
): void {
  const grouped = new Map<ReviewSignal["kind"], ReviewSignal[]>();
  for (const signal of signals) {
    const existing = grouped.get(signal.kind);
    if (existing) {
      existing.push(signal);
      continue;
    }
    grouped.set(signal.kind, [signal]);
  }

  for (const [kind, items] of grouped) {
    deps.emit<ReviewEventData>(`github:${kind}`, {
      ...data,
      signals: items,
    });
  }
}
export function tokenizeSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasContent = false;
  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasContent = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

async function pollWorkItems(
  deps: SourceStartDeps<GitHubSourceConfig>,
  query: string,
  seenWorkItems: Set<string>,
) {
  const raw = await gh(
    process.cwd(),
    "search",
    "prs",
    ...tokenizeSearchQuery(query),
    "--state",
    "open",
    deps.config.draft === true ? "--draft=true" : "--draft=false",
    "--json",
    "number,title,url,repository",
    "--limit",
    "100",
  );
  const items = parseGitHubSearchPrItems(raw);
  const candidates = items.map((item) => {
    const repo = item.repository.nameWithOwner;
    const data: WorkItemEventData = {
      externalId: `${repo}#${item.number}`,
      url: item.url,
      number: item.number,
      title: item.title,
      repo,
    };
    return { repo, externalId: data.externalId, data };
  });
  emitWorkItemBacklog(deps, GITHUB_WORK_ITEM_NEW_EVENT, seenWorkItems, candidates);
}

async function startGitHubSource(deps: SourceStartDeps<GitHubSourceConfig>): Promise<SourceHandle> {
  const snapshots = readReviewSourceSnapshots(
    deps.dataDir,
    "github",
    deps.projectId,
    deps.sourceId,
  );
  const seenWorkItems = deps.config.query
    ? readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId)
    : null;
  const lifecycleBaselined = readLifecycleBaselinedSessions(
    deps.dataDir,
    deps.projectId,
    deps.sourceId,
  );
  const adaptive = deps.config.adaptivePoll;
  const attemptedSessionIds = new Set<string>();
  // Tracks consecutive poll failures per session (catch-block errors or a failed CI
  // checks fetch). A session erroring on *every* cycle (persistent 404/permission
  // issue, not rate-limit/bad-creds — those are handled separately) would otherwise
  // never produce a "clean" cycle, latching lastCycleCiActive true forever and
  // defeating adaptivePoll source-wide. Past the tolerance, that session's failures
  // stop counting toward the hysteresis flag (still logged, just excluded from it).
  const consecutiveSessionPollErrors = new Map<string, number>();
  // sessionId -> the PR number that was found permanently unresolvable. A cache over
  // the on-disk registry (metadata.ts readGitHubPollDisabled/writeGitHubPollDisabled):
  // seeded here at handle start so the disable survives reloadAutomation recreating
  // this handle and daemon restart, write-through on every mutation (never a whole-map
  // dump — see safeRecordPollDisabled/safeClearPollDisabled), and refreshed once per
  // poll tick (refreshPollDisabled) so an in-process `poll-enable` interleaving this
  // handle's own event loop takes effect within one tick. Cleared when the session
  // rebinds away from that number or disappears (see the sweep at cycle end).
  let permanentPrNotFound = readGitHubPollDisabled(deps.dataDir, deps.projectId, deps.sourceId);
  // I4: an unconditional start-time prune, independent of the per-cycle sweep below.
  // Bounds the one genuinely unbounded leak path — authDisabled (see below) never
  // resets for the life of a handle, so under standing-bad-credentials the per-cycle
  // sweep in pollSignals never runs again until the next handle recreation.
  // Skipped entirely on the overwhelmingly common empty-registry start (the measured
  // shape is 2 sessions ever hitting this per source) — reloadAutomation recreates
  // every source handle on each config reload (27+ times in the measured 14.4h
  // window), so an unconditional listSessions(dataDir) here would cost one full
  // session-dir scan per source per reload for nothing.
  if (permanentPrNotFound.size > 0) {
    const startupSessionIds = new Set(listSessions(deps.dataDir).map((session) => session.id));
    const deadAtStartIds = [...permanentPrNotFound.keys()].filter(
      (sessionId) => !startupSessionIds.has(sessionId),
    );
    if (deadAtStartIds.length > 0) {
      // A genuinely independent fresh read, not the just-seeded cache above: feeding
      // writeGitHubPollDisabled from the cache (even a filtered copy of it) is the one
      // whole-map-write shape R0b forbids. This read happens with no await since the
      // seed above, so it is byte-identical to the cache at this point anyway — this
      // buys textual/structural cleanliness, not a different on-disk result.
      const startupRegistry = readGitHubPollDisabled(deps.dataDir, deps.projectId, deps.sourceId);
      for (const sessionId of deadAtStartIds) {
        permanentPrNotFound.delete(sessionId);
        startupRegistry.delete(sessionId);
      }
      try {
        writeGitHubPollDisabled(deps.dataDir, deps.projectId, deps.sourceId, startupRegistry);
      } catch (error) {
        deps.logger.warn?.(
          `[source:${deps.projectId}/${deps.sourceId}] failed to prune poll-disabled registry at start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  // sessionId -> transient poll-failure backoff state. Cleared on a clean observation
  // or when the session disappears.
  const transientPollBackoff = new Map<string, { failures: number; nextRetryAtMs: number }>();

  // sessionId -> the prNumber a failed record* write couldn't get onto disk (memory
  // says disabled, disk doesn't). refreshPollDisabled re-reads the whole registry
  // from disk every tick, which would otherwise silently undo an in-memory-only
  // record* mutation on the very next refresh — reproducing the measured defect
  // (repeat emits every tick) via a persistent write failure instead of a handle
  // restart. No clear-side entry: a failed clear leaves the stale disk entry, but
  // the in-memory delete at :455/:461 already happened (isSessionPollGated's
  // self-heal doesn't gate on the cache being write-clean), and overriding the next
  // refresh to re-delete it would suppress that refresh's own retry of the clear —
  // the disk entry would never heal even once writes recover. Cleared once a later
  // record* for that sessionId succeeds; also dropped by the sweep when the session
  // disappears.
  const pendingPollDisabledOverrides = new Map<string, number>();

  // Both wrap a synchronous fs write in try/catch and swallow-and-log, mirroring
  // logSpurEvent's own `catch {}` (event-log.ts:232-234). Mandatory, not defensive
  // style: safeRecordPollDisabled runs inside the per-session catch block at :590 —
  // an unguarded throw there escapes the session loop and lands on `void
  // pollCycle(false)` with no unhandledRejection handler anywhere in v2/src (see
  // review-providers/github.ts:1367-1371). safeClearPollDisabled runs from the
  // self-heal at isSessionPollGated, reached synchronously from the plain
  // setInterval callback below — an unguarded throw there is an uncaught exception,
  // not a rejection. A swallowed write failure degrades I1 to best-effort DURING THE
  // FAILURE WINDOW ONLY: pendingPollDisabledOverrides keeps the in-memory Map correct
  // across every refresh, so a persistently failing disk never re-arms more than the
  // one event already emitted before the first failure — it does not reproduce the
  // measured defect. No record* call is ever retried for that session: once the
  // override reapplies the entry on refresh, the gate at :461/:734 sees it as already
  // disabled and never re-enters safeRecordPollDisabled. The override only drops via
  // a rebind (the self-heal clear path, which does retry its own write every cycle —
  // see safeClearPollDisabled below), the sweep pruning a disappeared session, or
  // handle recreation reseeding from whatever the disk last held.
  const safeRecordPollDisabled = (sessionId: string, prNumber: number): void => {
    try {
      recordGitHubPollDisabledSession(
        deps.dataDir,
        deps.projectId,
        deps.sourceId,
        sessionId,
        prNumber,
      );
      pendingPollDisabledOverrides.delete(sessionId);
    } catch (error) {
      pendingPollDisabledOverrides.set(sessionId, prNumber);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] failed to persist poll-disabled state for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const safeClearPollDisabled = (sessionId: string): void => {
    // No override on failure (see pendingPollDisabledOverrides above): the caller
    // already deletes sessionId from the in-memory cache regardless of this call's
    // outcome, and letting the next refresh bring the stale disk entry back is what
    // makes isSessionPollGated's self-heal retry the clear on the following cycle.
    pendingPollDisabledOverrides.delete(sessionId);
    try {
      clearGitHubPollDisabledSession(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
    } catch (error) {
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] failed to clear poll-disabled state for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  // Refreshes the cache from disk once per tick so an in-process `poll-enable` (which
  // runs in the same daemon process and can interleave at any await in pollSignals)
  // takes effect within one tick. On a read failure, keep the current in-memory Map
  // rather than wiping it — a transient read error must not re-arm suppressed events.
  // Every pending override (a record* disk couldn't yet absorb) is re-applied on top
  // of the fresh disk read, so a persistent write failure can't undo its own
  // in-memory mutation on the very next tick.
  const refreshPollDisabled = (): void => {
    try {
      const fresh = readGitHubPollDisabled(deps.dataDir, deps.projectId, deps.sourceId);
      for (const [sessionId, prNumber] of pendingPollDisabledOverrides) {
        fresh.set(sessionId, prNumber);
      }
      permanentPrNotFound = fresh;
    } catch (error) {
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] failed to refresh poll-disabled state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const isSessionPollGated = (session: SessionRecord, nowMs: number): boolean => {
    const disabledPr = permanentPrNotFound.get(session.id);
    if (disabledPr !== undefined) {
      if (!session.pr || session.pr.number !== disabledPr) {
        safeClearPollDisabled(session.id);
        permanentPrNotFound.delete(session.id);
      } else {
        return true;
      }
    }
    return (transientPollBackoff.get(session.id)?.nextRetryAtMs ?? 0) > nowMs;
  };

  let nextEligiblePollAtMs = 0;
  let lastCycleCiActive = false;
  let stopped = false;
  let polling = false;
  let pollingWorkItems = false;
  let pollingCycle = false;
  let cooldownUntilMs = 0;
  let rateLimitFailures = 0;
  let authDisabled = false;
  let authWarned = false;

  const shouldSkipGitHubCalls = (): boolean => authDisabled || Date.now() < cooldownUntilMs;

  // Records a poll failure for a session and reports whether it should still count
  // toward this cycle's CI-active hysteresis flag. Returns false once the session has
  // failed more than CI_HYSTERESIS_ERROR_TOLERANCE cycles in a row, so a persistently
  // erroring session can't wedge the flag true forever.
  const countsTowardCiHysteresis = (sessionId: string): boolean => {
    const count = (consecutiveSessionPollErrors.get(sessionId) ?? 0) + 1;
    consecutiveSessionPollErrors.set(sessionId, count);
    return count <= CI_HYSTERESIS_ERROR_TOLERANCE;
  };

  const listPollableSessions = () =>
    listSessions(deps.dataDir).filter((session) =>
      isEligibleForSourcePoll(session, deps.projectId),
    );

  const shouldPollThisTick = (): boolean => {
    refreshPollDisabled();
    if (!adaptive) return true;
    if (Date.now() >= nextEligiblePollAtMs) return true;
    if (lastCycleCiActive) return true;
    for (const session of listPollableSessions()) {
      if (isSessionPollGated(session, Date.now())) continue;
      const existing = snapshots.get(session.id);
      if (session.pr && existing && hasTerminalSignal(existing.signals, session.pr.number))
        continue;
      if (!attemptedSessionIds.has(session.id)) return true;
      if (
        hasRecentSessionUserAction(
          deps.dataDir,
          session.id,
          ADAPTIVE_ACTIVITY_ACTIONS,
          Date.now() - adaptive.activeGraceMs,
        )
      ) {
        return true;
      }
    }
    return false;
  };

  const handleGitHubSuppressionError = (error: unknown): boolean => {
    const message = extractGithubErrorText(error);
    if (isGitHubBadCredentialsError(message)) {
      authDisabled = true;
      if (!authWarned) {
        authWarned = true;
        deps.logger.warn?.(
          `[source:${deps.projectId}/${deps.sourceId}] GitHub polling disabled: Bad credentials`,
        );
        logSpurEvent(deps.dataDir, {
          event: "source.auth.disabled",
          level: "error",
          projectId: deps.projectId,
          sourceId: deps.sourceId,
          message: `GitHub polling disabled for ${deps.projectId}/${deps.sourceId}: Bad credentials`,
        });
      }
      return true;
    }
    if (!isGitHubRateLimitError(message)) {
      return false;
    }

    rateLimitFailures += 1;
    const nowMs = Date.now();
    const resetMs = parseResetDeadlineMs(message, nowMs);
    const fallbackMs = Math.min(
      RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (rateLimitFailures - 1),
      RATE_LIMIT_BACKOFF_MAX_MS,
    );
    cooldownUntilMs = resetMs ?? nowMs + fallbackMs;
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] GitHub rate limit hit; polling paused until ${new Date(
        cooldownUntilMs,
      ).toISOString()}`,
    );
    return true;
  };

  const pollSignals = async (emitInitial: boolean): Promise<void> => {
    if (stopped || deps.signal.aborted || polling || shouldSkipGitHubCalls()) return;
    polling = true;
    try {
      const allSessions = listSessions(deps.dataDir);
      const sessions = allSessions.filter((session) =>
        isEligibleForSourcePoll(session, deps.projectId),
      );
      const existingSessionIds = new Set(allSessions.map((session) => session.id));
      const currentSessionIds = new Set(sessions.map((session) => session.id));
      let cycleCiActive = false;
      let cycleHadPollError = false;
      // Cycle-scoped: a batch-level failure logs one source.poll.error for every
      // member sharing its dedupeKey, not one per session (D4). Per-session backoff
      // and CI hysteresis below stay unconditional.
      const loggedBatchFailures = new Set<string>();
      const pollableSessions = [];

      for (const session of sessions) {
        // Skip only when the session is bound to a PR and the snapshot's terminal
        // signal is *for that PR*: terminal state, no new signals possible, and
        // re-polling burns the shared gh rate limit. Scoped by PR number so a
        // rebind to a new PR (`spur slots --link pr=...`) is always polled again —
        // a stale terminal snapshot from the PR the session used to be bound to
        // must never mute it. Unbound sessions are always polled (the only local
        // authority for "the current PR" is `session.pr`; see decision 2).
        // The snapshot persists to disk and reloads at startup, so the skip is
        // sticky across restarts: a CLOSED PR later reopened won't be re-detected
        // while the session stays bound to that PR number (no `reopened` lifecycle
        // kind exists). MERGED is unconditionally terminal.
        if (isSessionPollGated(session, Date.now())) continue;
        const existing = snapshots.get(session.id);
        if (session.pr && existing && hasTerminalSignal(existing.signals, session.pr.number)) {
          continue;
        }
        pollableSessions.push(session);
      }

      const collectedBySession = await collectGitHubSignalsBatch(
        pollableSessions,
        deps.dataDir,
        deps.projectId,
        deps.sourceId,
        deps.config.maxReviewBatchTargets,
      );
      for (const session of pollableSessions) {
        try {
          const restoreReplayRequested = hasGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            session.id,
          );
          const batchResult = collectedBySession.get(session.id);
          if (batchResult?.status !== "skipped" || batchResult.reason !== "capacity") {
            attemptedSessionIds.add(session.id);
          }
          if (!batchResult || batchResult.status === "skipped") continue;
          if (batchResult.status === "error") throw batchResult.error;
          const collected = batchResult.collected;
          if (collected?.ciActive) {
            cycleCiActive = true;
          }
          // A failed CI-check fetch is not a clean observation: it must not count
          // toward letting this cycle lower the CI-active hysteresis flag (see the
          // cycleHadPollError comment below), even though collectSignals itself
          // returned successfully. `!collected` (PR genuinely gone/not found) is a
          // clean observation, not a failure — only a failed checks fetch resets the
          // session's error streak below.
          if (collected?.ciCheckFetchFailed) {
            if (countsTowardCiHysteresis(session.id)) cycleHadPollError = true;
          } else {
            consecutiveSessionPollErrors.delete(session.id);
            transientPollBackoff.delete(session.id);
          }
          if (!collected) {
            snapshots.delete(session.id);
            deleteReviewSourceSnapshot(
              deps.dataDir,
              "github",
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            if (restoreReplayRequested) {
              clearGitHubMergeConflictRestoreReplay(
                deps.dataDir,
                deps.projectId,
                deps.sourceId,
                session.id,
              );
            }
            continue;
          }

          const previous = reviewSnapshotBaseline(
            snapshots.get(session.id),
            collected.data.prNumber,
          );
          const next = collected.snapshot;
          const changed = [...next.values()].filter((signal) => {
            const prior = previous?.get(signal.key);
            return !prior || prior.text !== signal.text;
          });

          // Built once, handed to both the in-memory map and the on-disk write so
          // the two copies cannot desync.
          const priorSnapshot = snapshots.get(session.id);
          const priorClearId =
            priorSnapshot?.prNumber === collected.data.prNumber
              ? priorSnapshot.mergeConflictClearId
              : undefined;
          const mergeConflictClearId =
            !next.has("merge_conflict") && (!priorClearId || previous?.has("merge_conflict"))
              ? randomUUID()
              : priorClearId;
          const nextSnapshot: ReviewSnapshot = {
            prNumber: collected.data.prNumber,
            signals: next,
            ...(mergeConflictClearId !== undefined ? { mergeConflictClearId } : {}),
          };
          if (mergeConflictClearId !== undefined)
            collected.data.mergeConflictClearId = mergeConflictClearId;
          snapshots.set(session.id, nextSnapshot);
          writeReviewSourceSnapshot(
            deps.dataDir,
            "github",
            deps.projectId,
            deps.sourceId,
            session.id,
            nextSnapshot,
          );

          const baselined = lifecycleBaselined.has(session.id);
          if (!baselined) {
            recordLifecycleBaselinedSession(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            lifecycleBaselined.add(session.id);
          }
          const candidates = previous ? changed : emitInitial ? [...next.values()] : [];
          const toEmit = baselined
            ? candidates
            : candidates.filter((signal) => !LIFECYCLE_KINDS.has(signal.kind));
          if (restoreReplayRequested) {
            const mergeConflictSignal = next.get("merge_conflict");
            if (
              mergeConflictSignal &&
              !toEmit.some((signal) => signal.key === mergeConflictSignal.key)
            )
              toEmit.push(mergeConflictSignal);
            clearGitHubMergeConflictRestoreReplay(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
          }
          if (toEmit.length > 0) {
            emitSignalsByKind(deps, collected.data, toEmit);
          }
        } catch (error) {
          const message = extractGithubErrorText(error);
          if (session.pr && isGitHubPermanentNotFoundError(message, session.pr.number)) {
            if (permanentPrNotFound.get(session.id) !== session.pr.number) {
              permanentPrNotFound.set(session.id, session.pr.number);
              safeRecordPollDisabled(session.id, session.pr.number);
              deps.logger.warn?.(
                `[source:${deps.projectId}/${deps.sourceId}] signal polling disabled for ${session.id}: PR #${session.pr.number} not found`,
              );
              logSpurEvent(deps.dataDir, {
                event: "source.poll.disabled",
                level: "warn",
                projectId: deps.projectId,
                sourceId: deps.sourceId,
                sessionId: session.id,
                message: `Signal polling disabled for ${deps.projectId}/${deps.sourceId}/${session.id}: PR #${session.pr.number} not found`,
                details: { prNumber: session.pr.number },
              });
            }
            transientPollBackoff.delete(session.id);
            consecutiveSessionPollErrors.delete(session.id);
            continue;
          }
          if (handleGitHubSuppressionError(error)) return;
          if (countsTowardCiHysteresis(session.id)) cycleHadPollError = true;
          // A batch-level failure (GitHubReviewBatchError) shares one dedupeKey across
          // every co-batched member: log it once per cycle, not once per member. Every
          // member still gets its own warn-worthy backoff update below regardless.
          const dedupeKey = error instanceof GitHubReviewBatchError ? error.dedupeKey : null;
          const alreadyLogged = dedupeKey !== null && loggedBatchFailures.has(dedupeKey);
          if (dedupeKey !== null) loggedBatchFailures.add(dedupeKey);
          if (!alreadyLogged) {
            deps.logger.warn?.(
              `[source:${deps.projectId}/${deps.sourceId}] failed to poll ${session.id}: ${message}`,
            );
            logSpurEvent(deps.dataDir, {
              event: "source.poll.error",
              level: "error",
              projectId: deps.projectId,
              sourceId: deps.sourceId,
              sessionId: session.id,
              message: `Signal poll failed for ${deps.projectId}/${deps.sourceId}/${session.id}: ${message}`,
            });
          }
          const existingBackoff = transientPollBackoff.get(session.id);
          const failures = (existingBackoff?.failures ?? 0) + 1;
          transientPollBackoff.set(session.id, {
            failures,
            nextRetryAtMs:
              Date.now() +
              Math.min(
                SESSION_POLL_BACKOFF_BASE_MS * 2 ** (failures - 1),
                SESSION_POLL_BACKOFF_MAX_MS,
              ),
          });
        }
      }

      // A per-session poll error means this cycle's CI observation is incomplete, not
      // that CI stopped: only let the cycle *lower* the hysteresis flag to false when
      // every session was actually observed cleanly. A freshly observed active check
      // still raises it regardless.
      lastCycleCiActive = cycleCiActive || (cycleHadPollError && lastCycleCiActive);

      for (const sessionId of [...snapshots.keys()]) {
        if (!currentSessionIds.has(sessionId)) {
          snapshots.delete(sessionId);
          deleteReviewSourceSnapshot(
            deps.dataDir,
            "github",
            deps.projectId,
            deps.sourceId,
            sessionId,
          );
          clearGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            sessionId,
          );
          removeLifecycleBaselinedSession(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
          lifecycleBaselined.delete(sessionId);
        }
      }

      for (const sessionId of [...attemptedSessionIds]) {
        if (!currentSessionIds.has(sessionId)) attemptedSessionIds.delete(sessionId);
      }

      for (const sessionId of [...consecutiveSessionPollErrors.keys()]) {
        if (!currentSessionIds.has(sessionId)) consecutiveSessionPollErrors.delete(sessionId);
      }

      // Prunes on absence from ALL sessions on disk (existingSessionIds), not
      // eligibility (currentSessionIds) — I5: a stopped or stale-parked session keeps
      // its entry. This is the one legitimate multi-key registry write: the map it
      // writes is a FRESH readGitHubPollDisabled minus the dead ids, never the cache
      // (R0b), and there is no await between that read and the write (I8) so no
      // concurrent poll-enable can interleave and be clobbered.
      for (const sessionId of [...permanentPrNotFound.keys()]) {
        if (!existingSessionIds.has(sessionId)) permanentPrNotFound.delete(sessionId);
      }
      for (const sessionId of [...pendingPollDisabledOverrides.keys()]) {
        if (!existingSessionIds.has(sessionId)) pendingPollDisabledOverrides.delete(sessionId);
      }
      const freshPollDisabled = readGitHubPollDisabled(deps.dataDir, deps.projectId, deps.sourceId);
      let prunedPollDisabled = false;
      for (const sessionId of [...freshPollDisabled.keys()]) {
        if (!existingSessionIds.has(sessionId)) {
          freshPollDisabled.delete(sessionId);
          prunedPollDisabled = true;
        }
      }
      if (prunedPollDisabled) {
        try {
          writeGitHubPollDisabled(deps.dataDir, deps.projectId, deps.sourceId, freshPollDisabled);
        } catch (error) {
          deps.logger.warn?.(
            `[source:${deps.projectId}/${deps.sourceId}] failed to prune poll-disabled registry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      for (const sessionId of [...transientPollBackoff.keys()]) {
        if (!currentSessionIds.has(sessionId)) transientPollBackoff.delete(sessionId);
      }
    } finally {
      polling = false;
    }
  };

  const syncWorkItems = async (): Promise<void> => {
    if (
      !deps.config.query ||
      !seenWorkItems ||
      stopped ||
      deps.signal.aborted ||
      pollingWorkItems ||
      shouldSkipGitHubCalls()
    ) {
      return;
    }
    pollingWorkItems = true;
    try {
      await pollWorkItems(deps, deps.config.query, seenWorkItems);
    } catch (error) {
      if (handleGitHubSuppressionError(error)) return;
      const message = extractGithubErrorText(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] work-item poll failed: ${message}`,
      );
      logSpurEvent(deps.dataDir, {
        event: "source.work_item_poll.error",
        level: "error",
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        message: `Work-item poll failed for ${deps.projectId}/${deps.sourceId}: ${message}`,
      });
    } finally {
      pollingWorkItems = false;
    }
  };

  const pollCycle = async (emitInitial: boolean, pollDisabledRefreshed = false): Promise<void> => {
    if (pollingCycle) return;
    pollingCycle = true;
    if (!pollDisabledRefreshed) {
      refreshPollDisabled();
    }
    // Captured before pollSignals runs: if a cooldown/auth-disabled gate was
    // already active going into this cycle, no real polling happened, so the
    // adaptive deadline must not move — otherwise it silently consumes the
    // slow window during an outage instead of resuming promptly once it lifts.
    const skippedByCooldown = shouldSkipGitHubCalls();
    const adaptiveDeadlineAtStart = nextEligiblePollAtMs;
    try {
      await runGhPollCycle(
        { kind: "github_source", projectId: deps.projectId, sourceId: deps.sourceId },
        async () => {
          await pollSignals(emitInitial);
          if (shouldSkipGitHubCalls()) return;
          await syncWorkItems();
          if (!shouldSkipGitHubCalls()) {
            rateLimitFailures = 0;
          }
        },
      );
    } finally {
      if (adaptive && !skippedByCooldown && Date.now() >= adaptiveDeadlineAtStart) {
        nextEligiblePollAtMs = Date.now() + adaptive.slowIntervalMs;
      }
      pollingCycle = false;
    }
  };

  const timer = startInterval(() => {
    if (!shouldPollThisTick()) return;
    void pollCycle(false, true);
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void pollCycle(false);
    } else {
      await pollCycle(false);
    }
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    ...(deps.config.runOnStart
      ? {
          runOnStart(): void {
            void pollCycle(true);
          },
        }
      : {}),
  };
}

export const githubSourceModule: SourceModule<GitHubSourceConfig> = {
  type: "github",
  start: startGitHubSource,
};
