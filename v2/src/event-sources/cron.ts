import { Cron } from "croner";
import type { CronSourceConfig } from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

const CRON_GUARD_SAMPLE_RUNS = 64;

function deriveMinimumIntervalMs(cronJob: Cron, schedule: string): number {
  const runs = cronJob.nextRuns(CRON_GUARD_SAMPLE_RUNS);
  if (runs.length < 2) {
    throw new Error(`Unable to derive a minimum interval from cron schedule "${schedule}"`);
  }

  let minimumIntervalMs = Number.POSITIVE_INFINITY;
  for (let index = 1; index < runs.length; index += 1) {
    const previousRun = runs[index - 1];
    const nextRun = runs[index];
    if (!previousRun || !nextRun) continue;
    const intervalMs = nextRun.getTime() - previousRun.getTime();
    if (intervalMs > 0 && intervalMs < minimumIntervalMs) {
      minimumIntervalMs = intervalMs;
    }
  }

  if (!Number.isFinite(minimumIntervalMs)) {
    throw new Error(`Unable to derive a minimum interval from cron schedule "${schedule}"`);
  }

  return minimumIntervalMs;
}

async function startCronSource(deps: SourceStartDeps<CronSourceConfig>): Promise<SourceHandle> {
  const { schedule, runOnStart } = deps.config;
  let stopped = false;
  let lastTriggeredAt: number | null = null;

  const cronJob = new Cron(schedule, () => {
    emitTick("schedule");
  });
  const minimumIntervalMs = deriveMinimumIntervalMs(cronJob, schedule);

  const emitTick = (reason: "runOnStart" | "schedule"): void => {
    if (stopped || deps.signal.aborted) return;
    const now = Date.now();
    if (lastTriggeredAt !== null && now - lastTriggeredAt < minimumIntervalMs) {
      deps.logger.info?.(
        `[source:${deps.projectId}/${deps.sourceId}] cron tick suppressed: reason=${reason}, schedule="${schedule}", minimumIntervalMs=${minimumIntervalMs}, elapsedMs=${now - lastTriggeredAt}`,
      );
      return;
    }
    lastTriggeredAt = now;
    deps.emit("cron:tick");
  };

  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] cron started: schedule="${schedule}", event="cron:tick", runOnStart=${runOnStart}, minimumIntervalMs=${minimumIntervalMs}`,
  );

  return {
    stop(): void {
      stopped = true;
      cronJob.stop();
    },
    ...(runOnStart
      ? {
          runOnStart(): void {
            emitTick("runOnStart");
          },
        }
      : {}),
  };
}

export const cronSourceModule: SourceModule = {
  type: "cron",
  start: startCronSource,
};
