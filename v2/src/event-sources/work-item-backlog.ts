import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import {
  markWorkItemRetriesEmitted,
  readWorkItemLifecycles,
  readWorkItemRegistry,
  recordWorkItem,
} from "../metadata.js";
import type { SourceConfig } from "../types.js";
import {
  compareWorkItemRetryOrder,
  isWorkItemRecordEmitDue,
  WORK_ITEM_RETRY_EMIT_CAP,
} from "../work-item-retry.js";
import type { SourceHandle, SourceStartDeps } from "./types.js";

type WorkItemSourceConfig = Extract<SourceConfig, { emitExisting: boolean }>;

// First-poll emits for a repo absent from the registry are capped so a backlog
// of existing work items cannot spawn an unbounded burst of agents. Every
// returned item is still recorded as seen regardless of the cap.
export const WORK_ITEM_FIRST_POLL_EMIT_CAP = 10;

export interface WorkItemCandidate<TData> {
  repo: string;
  externalId: string;
  data: TData;
}

// Records each unseen candidate and emits it as `eventName`, except for a
// repo's first-poll backlog (a repo with no prior seen entries). Such backlog
// items are recorded but suppressed unless `emitExisting` is set, in which case
// they are emitted up to WORK_ITEM_FIRST_POLL_EMIT_CAP per repo. Seen
// candidates whose lifecycle record has a due retry are re-emitted, at most
// WORK_ITEM_RETRY_EMIT_CAP per poll: a candidate is in the current poll result,
// so a closed or merged item never retries.
export function emitWorkItemBacklog<TData>(
  deps: SourceStartDeps<WorkItemSourceConfig>,
  eventName: string,
  seen: Set<string>,
  candidates: Iterable<WorkItemCandidate<TData>>,
): void {
  const reposWithSeenEntries = new Set([...seen].map((id) => id.split("#")[0]));
  const firstPollEmitCounts = new Map<string, number>();
  const seenCandidates = new Map<string, WorkItemCandidate<TData>>();
  for (const candidate of candidates) {
    if (seen.has(candidate.externalId)) {
      seenCandidates.set(candidate.externalId, candidate);
      continue;
    }
    recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, candidate.externalId);
    seen.add(candidate.externalId);
    if (!reposWithSeenEntries.has(candidate.repo)) {
      if (!deps.config.emitExisting) continue;
      const emitted = firstPollEmitCounts.get(candidate.repo) ?? 0;
      if (emitted >= WORK_ITEM_FIRST_POLL_EMIT_CAP) continue;
      firstPollEmitCounts.set(candidate.repo, emitted + 1);
    }
    deps.emit<TData>(eventName, candidate.data);
  }
  emitDueRetries(deps, eventName, seenCandidates);
}

function emitDueRetries<TData>(
  deps: SourceStartDeps<WorkItemSourceConfig>,
  eventName: string,
  seenCandidates: ReadonlyMap<string, WorkItemCandidate<TData>>,
): void {
  if (seenCandidates.size === 0) return;
  const nowMs = Date.now();
  const due = [...readWorkItemLifecycles(deps.dataDir, deps.projectId, deps.sourceId).values()]
    .filter(
      (record) => seenCandidates.has(record.externalId) && isWorkItemRecordEmitDue(record, nowMs),
    )
    .sort(compareWorkItemRetryOrder)
    .slice(0, WORK_ITEM_RETRY_EMIT_CAP);
  if (due.length === 0) return;
  markWorkItemRetriesEmitted(
    deps.dataDir,
    deps.projectId,
    deps.sourceId,
    due.map((record) => record.externalId),
    new Date(nowMs).toISOString(),
  );
  for (const record of due) {
    const candidate = seenCandidates.get(record.externalId);
    if (candidate) deps.emit<TData>(eventName, candidate.data);
  }
}

// Shared lifecycle for work-item polling sources (Sentry, GitHub CI). Owns the
// seen registry, reentrancy/abort guards, interval, error logging, and the
// runOnStart vs immediate-first-poll handling. The source supplies its poll
// function and the labels used in the two failure log lines.
export async function startWorkItemPoller<TConfig extends WorkItemSourceConfig>(
  deps: SourceStartDeps<TConfig>,
  labels: { warn: string; event: string },
  poll: (deps: SourceStartDeps<TConfig>, seen: Set<string>) => Promise<void>,
): Promise<SourceHandle> {
  const seen = readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId);
  let stopped = false;
  let polling = false;

  const sync = async (): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
    polling = true;
    try {
      await poll(deps, seen);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn?.(`[source:${deps.projectId}/${deps.sourceId}] ${labels.warn}: ${message}`);
      logSpurEvent(deps.dataDir, {
        event: "source.work_item_poll.error",
        level: "error",
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        message: `${labels.event} for ${deps.projectId}/${deps.sourceId}: ${message}`,
      });
    } finally {
      polling = false;
    }
  };

  const timer = startInterval(() => {
    void sync();
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void sync();
    } else {
      await sync();
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
            void sync();
          },
        }
      : {}),
  };
}
