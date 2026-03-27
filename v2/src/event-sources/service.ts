import { clearInterval, setInterval as startInterval } from "node:timers";
import {
  listServiceInstances,
  readServiceSourceState,
  writeServiceSourceState,
  deleteServiceSourceState,
} from "../metadata.js";
import { captureTmuxPane, tmuxSessionExists } from "../runtime-tmux.js";
import type {
  ServiceProblemEventData,
  ServiceSourceConfig,
  ServiceSourceState,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

function normalizeLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function appendedLines(previous: string[], next: string[]): string[] {
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

function createInitialState(serviceId: string, ruleIds: string[]): ServiceSourceState {
  return {
    serviceId,
    lastTailLines: [],
    rules: Object.fromEntries(ruleIds.map((ruleId) => [ruleId, { active: false }])),
  };
}

async function startServiceSource(deps: SourceStartDeps<ServiceSourceConfig>): Promise<SourceHandle> {
  const compiledRules = Object.fromEntries(
    Object.entries(deps.config.rules).map(([ruleId, rule]) => [
      ruleId,
      {
        match: new RegExp(rule.match),
        clear: rule.clear ? new RegExp(rule.clear) : null,
        cooldownMs: rule.cooldownMs,
      },
    ]),
  );
  let stopped = false;
  let polling = false;

  const poll = async (): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
    polling = true;
    try {
      const services = listServiceInstances(deps.dataDir).filter(
        (service) => service.project === deps.projectId && service.serviceId === deps.config.service,
      );

      for (const service of services) {
        const runtimeAlive = await tmuxSessionExists(service.tmuxSession);
        if (!runtimeAlive) {
          deleteServiceSourceState(deps.dataDir, deps.projectId, deps.sourceId, service.sessionId);
          continue;
        }

        const currentLines = normalizeLines(
          await captureTmuxPane(service.tmuxSession, deps.config.tailLines),
        );
        const currentState =
          readServiceSourceState(deps.dataDir, deps.projectId, deps.sourceId, service.sessionId) ??
          createInitialState(service.serviceId, Object.keys(deps.config.rules));
        const newLines = appendedLines(currentState.lastTailLines, currentLines);
        const nextState: ServiceSourceState = {
          serviceId: service.serviceId,
          lastTailLines: currentLines,
          rules: { ...currentState.rules },
        };
        const now = Date.now();

        for (const [ruleId, rule] of Object.entries(compiledRules)) {
          const prior = nextState.rules[ruleId] ?? { active: false };
          let active = prior.active;
          let shouldEmit = false;
          for (const line of newLines) {
            if (rule.clear) {
              rule.clear.lastIndex = 0;
            }
            if (rule.clear?.test(line)) {
              active = false;
            }
            rule.match.lastIndex = 0;
            if (rule.match.test(line)) {
              active = true;
              const lastAlertAt = prior.lastAlertAt ? Date.parse(prior.lastAlertAt) : Number.NaN;
              if (Number.isNaN(lastAlertAt) || now - lastAlertAt >= rule.cooldownMs) {
                shouldEmit = true;
              }
            }
          }
          nextState.rules[ruleId] = {
            active,
            ...(shouldEmit
              ? { lastAlertAt: new Date(now).toISOString() }
              : prior.lastAlertAt
                ? { lastAlertAt: prior.lastAlertAt }
                : {}),
          };
          if (shouldEmit) {
            deps.emit<ServiceProblemEventData>(`service:${ruleId}`, {
              sessionId: service.sessionId,
              serviceId: service.serviceId,
              ruleId,
            });
          }
        }

        writeServiceSourceState(
          deps.dataDir,
          deps.projectId,
          deps.sourceId,
          service.sessionId,
          nextState,
        );
      }
    } finally {
      polling = false;
    }
  };

  const timer = startInterval(() => {
    void poll();
  }, deps.config.intervalMs);

  if (!deps.deferInitialSync || deps.config.runOnStart) {
    void poll();
  }

  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] service started: service=${deps.config.service}, intervalMs=${deps.config.intervalMs}, events="service:*", runOnStart=${deps.config.runOnStart}`,
  );

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    ...(deps.config.runOnStart
      ? {
          runOnStart(): void {
            void poll();
          },
        }
      : {}),
  };
}

export const serviceSourceModule: SourceModule = {
  type: "service",
  start: startServiceSource,
};
