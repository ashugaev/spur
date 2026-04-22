import type { ServiceSourceConfig } from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

export function normalizeLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function appendedLines(previous: string[], next: string[]): string[] {
  const limit = Math.min(previous.length, next.length);
  for (let overlap = limit; overlap >= 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (previous[previous.length - overlap + index] !== next[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return next.slice(overlap);
    }
  }
  return next;
}

async function startServiceSource(
  deps: SourceStartDeps<ServiceSourceConfig>,
): Promise<SourceHandle> {
  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] service started without tmux log polling: service=${deps.config.service}`,
  );
  return {
    stop(): void {
      // Service sources stay configured, but tmux pane capture is disabled.
    },
  };
}

export const serviceSourceModule: SourceModule = {
  type: "service",
  start: startServiceSource,
};
