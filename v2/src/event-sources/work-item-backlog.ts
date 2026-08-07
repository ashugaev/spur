import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { readWorkItemRegistry, recordWorkItem } from "../metadata.js";
import type { SourceConfig } from "../types.js";
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
// they are emitted up to WORK_ITEM_FIRST_POLL_EMIT_CAP per repo.
export function emitWorkItemBacklog<TData>(
  deps: SourceStartDeps<WorkItemSourceConfig>,
  eventName: string,
  seen: Set<string>,
  candidates: Iterable<WorkItemCandidate<TData>>,
): void {
  const reposWithSeenEntries = new Set([...seen].map((id) => id.split("#")[0]));
  const firstPollEmitCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.externalId)) continue;
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
