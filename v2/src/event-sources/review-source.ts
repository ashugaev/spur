import { existsSync } from "node:fs";
import { clearInterval, setInterval as startInterval } from "node:timers";
import {
  deleteReviewSourceSnapshot,
  listSessions,
  readReviewSourceSnapshots,
  writeReviewSourceSnapshot,
} from "../metadata.js";
import type {
  ReviewEventData,
  ReviewProviderId,
  ReviewSignal,
  ReviewSignalKind,
  ReviewSourceConfig,
} from "../types.js";
import { reviewProvider } from "../review-providers/index.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

function emitSignalsByKind(
  providerId: ReviewProviderId,
  deps: SourceStartDeps<ReviewSourceConfig>,
  data: Omit<ReviewEventData, "signals">,
  signals: ReviewSignal[],
): void {
  const grouped = new Map<ReviewSignalKind, ReviewSignal[]>();
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
          const sessions = listSessions(deps.dataDir).filter(
            (session) =>
              session.project === deps.projectId &&
              session.status === "running" &&
              Boolean(session.worktreePath) &&
              existsSync(session.worktreePath),
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

              const previous = snapshots.get(session.id);
              const next = collected.snapshot;
              const changed = [...next.values()].filter((signal) => {
                const prior = previous?.get(signal.key);
                return !prior || prior.text !== signal.text;
              });

              snapshots.set(session.id, next);
              writeReviewSourceSnapshot(
                deps.dataDir,
                providerId,
                deps.projectId,
                deps.sourceId,
                session.id,
                next,
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
