import { clearInterval, setInterval as startInterval } from "node:timers";
import { listSessions, readServiceSourceState, writeServiceSourceState } from "../metadata.js";
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

export type ServiceEvaluationMode = "normal" | "suppress";

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
    const matched = matchIndex >= 0 && matchIndex > clearIndex;
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
      matched && mode !== "suppress" && (previousRule?.active !== true || cooldownElapsed);
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

export interface ServiceSourceStateUpdateArgs {
  dataDir: string;
  projectId: string;
  sourceId: string;
  sessionId: string;
  config: ServiceSourceConfig;
  tailLines: string[];
  candidateLines: (previous: ServiceSourceState | null) => string[];
  nowMs: number;
  mode: ServiceEvaluationMode;
}

interface StateLockEntry {
  active: number;
  tail: Promise<void>;
}

const stateLocks = new Map<string, StateLockEntry>();

function stateLockKey(
  args: Pick<ServiceSourceStateUpdateArgs, "dataDir" | "projectId" | "sourceId" | "sessionId">,
): string {
  return JSON.stringify([args.dataDir, args.projectId, args.sourceId, args.sessionId]);
}

async function withStateLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  let entry = stateLocks.get(key);
  if (!entry) {
    entry = { active: 0, tail: Promise.resolve() };
    stateLocks.set(key, entry);
  }
  entry.active += 1;
  const previous = entry.tail.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  entry.tail = previous.then(() => current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    entry.active -= 1;
    if (entry.active === 0) {
      stateLocks.delete(key);
    }
  }
}

export async function updateServiceSourceState(
  args: ServiceSourceStateUpdateArgs,
): Promise<ServiceSourceEvaluation> {
  return withStateLock(stateLockKey(args), () => {
    const previous = readServiceSourceState(
      args.dataDir,
      args.projectId,
      args.sourceId,
      args.sessionId,
    );
    const evaluation = evaluateServiceSourceState({
      config: args.config,
      previous,
      tailLines: args.tailLines,
      candidateLines: args.candidateLines(previous),
      nowMs: args.nowMs,
      mode: args.mode,
    });
    writeServiceSourceState(
      args.dataDir,
      args.projectId,
      args.sourceId,
      args.sessionId,
      evaluation.state,
    );
    return evaluation;
  });
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
  let pollChain: Promise<void> = Promise.resolve();

  const pollSession = async (sessionId: string, mode: ServiceEvaluationMode): Promise<void> => {
    if (!(await sidecarTmuxAlive(sessionId, deps.config.service))) {
      return;
    }

    const tmuxSession = sidecarTmuxSession(sessionId, deps.config.service);
    const tailLines = normalizeLines(await captureTmuxPane(tmuxSession, deps.config.tailLines));
    const evaluation = await updateServiceSourceState({
      dataDir: deps.dataDir,
      projectId: deps.projectId,
      sourceId: deps.sourceId,
      sessionId,
      config: deps.config,
      tailLines,
      candidateLines: (previous) =>
        previous && mode === "normal"
          ? appendedLines(previous.lastTailLines, tailLines)
          : tailLines,
      nowMs: Date.now(),
      mode,
    });
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
    if (stopped || deps.signal.aborted) return;
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
  };

  const queuePoll = (mode: ServiceEvaluationMode): void => {
    pollChain = pollChain.catch(() => undefined).then(() => poll(mode));
    void pollChain;
  };

  queuePoll("suppress");
  const timer = startInterval(() => {
    queuePoll("normal");
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
  const handle = {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
  return deps.config.runOnStart
    ? {
        ...handle,
        runOnStart(): void {
          queuePoll("normal");
        },
      }
    : handle;
}

export const serviceSourceModule: SourceModule = {
  type: "service",
  start: startServiceSource,
};
