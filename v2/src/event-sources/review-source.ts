import { clearInterval, setInterval as startInterval } from "node:timers";
import {
  deleteReviewSourceSnapshot,
  listSessions,
  readReviewSourceSnapshots,
  writeReviewSourceSnapshot,
} from "../metadata.js";
import {
  reviewSnapshotBaseline,
  type ReviewEventData,
  type ReviewProviderId,
  type ReviewSignal,
  type ReviewSnapshot,
  type ReviewSourceConfig,
} from "../types.js";
import { reviewProvider } from "../review-providers/index.js";
import {
  isEligibleForSourcePoll,
  type SourceHandle,
  type SourceModule,
  type SourceStartDeps,
} from "./types.js";

function emitSignalsByKind(
  providerId: ReviewProviderId,
  deps: SourceStartDeps<ReviewSourceConfig>,
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
    deps.emit<ReviewEventData>(`${providerId}:${kind}`, {
      ...data,
      signals: items,
    });
  }
}

export function createReviewSourceModule(
  providerId: ReviewProviderId,
): SourceModule<ReviewSourceConfig> {
  const provider = reviewProvider(providerId);
  return {
    type: providerId,
    async start(deps): Promise<SourceHandle> {
      const snapshots = readReviewSourceSnapshots(
        deps.dataDir,
        providerId,
        deps.projectId,
        deps.sourceId,
      );
      let stopped = false;
      let polling = false;

      const poll = async (emitInitial: boolean): Promise<void> => {
        if (stopped || deps.signal.aborted || polling) return;
        polling = true;
        try {
          const sessions = listSessions(deps.dataDir).filter((session) =>
            isEligibleForSourcePoll(session, deps.projectId),
          );
          const currentSessionIds = new Set<string>();

          for (const session of sessions) {
            currentSessionIds.add(session.id);
            try {
              const collected = await provider.collectSignals(
                session,
                deps.dataDir,
                deps.projectId,
                deps.sourceId,
              );
              if (!collected) {
                snapshots.delete(session.id);
                deleteReviewSourceSnapshot(
                  deps.dataDir,
                  providerId,
                  deps.projectId,
                  deps.sourceId,
                  session.id,
                );
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

              // Built once, handed to both the in-memory map and the on-disk write
              // so the two copies cannot desync.
              const nextSnapshot: ReviewSnapshot = {
                prNumber: collected.data.prNumber,
                signals: next,
              };
              snapshots.set(session.id, nextSnapshot);
              writeReviewSourceSnapshot(
                deps.dataDir,
                providerId,
                deps.projectId,
                deps.sourceId,
                session.id,
                nextSnapshot,
              );
              if ((previous && changed.length > 0) || (!previous && emitInitial && next.size > 0)) {
                emitSignalsByKind(
                  providerId,
                  deps,
                  collected.data,
                  previous ? changed : [...next.values()],
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              deps.logger.warn?.(
                `[source:${deps.projectId}/${deps.sourceId}] failed to poll ${session.id}: ${message}`,
              );
            }
          }

          for (const sessionId of [...snapshots.keys()]) {
            if (!currentSessionIds.has(sessionId)) {
              snapshots.delete(sessionId);
              deleteReviewSourceSnapshot(
                deps.dataDir,
                providerId,
                deps.projectId,
                deps.sourceId,
                sessionId,
              );
            }
          }
        } finally {
          polling = false;
        }
      };

      const timer = startInterval(() => {
        void poll(false);
      }, deps.config.intervalMs);

      if (!deps.config.runOnStart) {
        if (deps.deferInitialSync) {
          void poll(false);
        } else {
          await poll(false);
        }
      }

      deps.logger.info?.(
        `[source:${deps.projectId}/${deps.sourceId}] ${providerId} started: intervalMs=${deps.config.intervalMs}, events="${providerId}:*", runOnStart=${deps.config.runOnStart}`,
      );

      return {
        stop(): void {
          stopped = true;
          clearInterval(timer);
        },
        ...(deps.config.runOnStart
          ? {
              runOnStart(): void {
                void poll(true);
              },
            }
          : {}),
      };
    },
  };
}
