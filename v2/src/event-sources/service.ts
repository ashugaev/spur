import { clearInterval, setInterval as startInterval } from "node:timers";
import {
  deleteServiceSourceState,
  listSessions,
  readServiceSourceState,
  writeServiceSourceState,
} from "../metadata.js";
import { captureTmuxPane, sidecarTmuxAlive, sidecarTmuxSession } from "../runtime-tmux.js";
import type { ServiceProblemEventData, ServiceSourceConfig, ServiceSourceState } from "../types.js";
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

type ServiceEvaluationMode = "normal" | "suppress" | "force";

export interface ServiceSourceEvaluation {
  state: ServiceSourceState;
  matchedRuleIds: string[];
}

function lastPatternIndex(lines: string[], pattern: string): number {
  const re = new RegExp(pattern);
  let matchedIndex = -1;
  lines.forEach((line, index) => {
    re.lastIndex = 0;
    if (re.test(line)) {
      matchedIndex = index;
    }
  });
  return matchedIndex;
}

function lastAlertMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateServiceSourceState(args: {
  config: ServiceSourceConfig;
  previous: ServiceSourceState | null;
  tailLines: string[];
  candidateLines: string[];
  nowMs: number;
  mode?: ServiceEvaluationMode;
}): ServiceSourceEvaluation {
  const mode = args.mode ?? "normal";
  const matchedRuleIds: string[] = [];
  const rules: ServiceSourceState["rules"] = {};

  for (const [ruleId, rule] of Object.entries(args.config.rules)) {
    const previousRule = args.previous?.rules[ruleId];
    const clearIndex = rule.clear ? lastPatternIndex(args.candidateLines, rule.clear) : -1;
    const matchIndex = lastPatternIndex(args.candidateLines, rule.match);
    const matched = matchIndex >= 0 && matchIndex >= clearIndex;
    const active = matched ? true : clearIndex >= 0 ? false : previousRule?.active === true;
    const lastMatch = matched
      ? args.candidateLines[matchIndex]
      : active
        ? previousRule?.lastMatch
        : undefined;
    const previousAlertMs = lastAlertMs(previousRule?.lastAlertAt);
    const cooldownElapsed =
      previousAlertMs === null || args.nowMs - previousAlertMs >= rule.cooldownMs;
    const shouldEmit =
      matched &&
      mode !== "suppress" &&
      (mode === "force" || previousRule?.active !== true || cooldownElapsed);
    const lastAlertAt = shouldEmit ? new Date(args.nowMs).toISOString() : previousRule?.lastAlertAt;

    if (shouldEmit) {
      matchedRuleIds.push(ruleId);
    }
    rules[ruleId] = {
      active,
      ...(lastAlertAt ? { lastAlertAt } : {}),
      ...(lastMatch ? { lastMatch } : {}),
    };
  }

  return {
    state: {
      serviceId: args.config.service,
      lastTailLines: args.tailLines,
      rules,
    },
    matchedRuleIds,
  };
}

async function startServiceSource(
  deps: SourceStartDeps<ServiceSourceConfig>,
): Promise<SourceHandle> {
  if (deps.config.targetKind !== "sidecar") {
    deps.logger.info?.(
      `[source:${deps.projectId}/${deps.sourceId}] service started without tmux log polling: service=${deps.config.service}`,
    );
    return {
      stop(): void {
        // Service sources stay configured, but tmux pane capture is disabled.
      },
    };
  }

  let stopped = false;
  let polling = false;

  const pollSession = async (sessionId: string, mode: ServiceEvaluationMode): Promise<void> => {
    if (!(await sidecarTmuxAlive(sessionId, deps.config.service))) {
      deleteServiceSourceState(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
      return;
    }

    const tmuxSession = sidecarTmuxSession(sessionId, deps.config.service);
    const tailLines = normalizeLines(await captureTmuxPane(tmuxSession, deps.config.tailLines));
    const previous = readServiceSourceState(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
    const candidateLines =
      previous && mode === "normal" ? appendedLines(previous.lastTailLines, tailLines) : tailLines;
    const evaluation = evaluateServiceSourceState({
      config: deps.config,
      previous,
      tailLines,
      candidateLines,
      nowMs: Date.now(),
      mode,
    });
    writeServiceSourceState(
      deps.dataDir,
      deps.projectId,
      deps.sourceId,
      sessionId,
      evaluation.state,
    );
    for (const ruleId of evaluation.matchedRuleIds) {
      deps.emit<ServiceProblemEventData>(`service:${ruleId}`, {
        sessionId,
        serviceId: deps.config.service,
        runtimeKind: deps.config.targetKind,
        ruleId,
      });
    }
  };

  const poll = async (mode: ServiceEvaluationMode): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
    polling = true;
    try {
      const sessions = listSessions(deps.dataDir).filter(
        (session) => session.project === deps.projectId && session.status === "running",
      );
      for (const session of sessions) {
        try {
          await pollSession(session.id, mode);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn?.(
            `[source:${deps.projectId}/${deps.sourceId}] failed to poll sidecar ${deps.config.service} for ${session.id}: ${message}`,
          );
        }
      }
    } finally {
      polling = false;
    }
  };

  void poll("suppress");
  const timer = startInterval(() => {
    void poll("normal");
  }, deps.config.intervalMs);
  deps.signal.addEventListener(
    "abort",
    () => {
      stopped = true;
      clearInterval(timer);
    },
    { once: true },
  );
  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] sidecar log source started: sidecar=${deps.config.service}`,
  );
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    runOnStart(): void {
      void poll("force");
    },
  };
}

export const serviceSourceModule: SourceModule = {
  type: "service",
  start: startServiceSource,
};
