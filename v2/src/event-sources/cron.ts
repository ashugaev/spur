import { Cron } from "croner";
import type { CronSourceConfig } from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

async function startCronSource(deps: SourceStartDeps<CronSourceConfig>): Promise<SourceHandle> {
  const { schedule, runOnStart } = deps.config;
  let stopped = false;

  const emitTick = (): void => {
    if (stopped || deps.signal.aborted) return;
    deps.emit("cron:tick");
  };

  const cronJob = new Cron(schedule, () => {
    emitTick();
  });

  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] cron started: schedule="${schedule}", event="cron:tick", runOnStart=${runOnStart}`,
  );

  return {
    stop(): void {
      stopped = true;
      cronJob.stop();
    },
    ...(runOnStart
      ? {
          runOnStart(): void {
            emitTick();
          },
        }
      : {}),
  };
}

export const cronSourceModule: SourceModule = {
  type: "cron",
  start: startCronSource,
};
