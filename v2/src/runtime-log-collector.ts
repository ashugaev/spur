import { clearInterval, setInterval as startInterval } from "node:timers";
import { appendedLines, normalizeLines } from "./event-sources/service.js";
import { logSpurEvent } from "./event-log.js";
import {
  deleteRuntimeLogCursor,
  listRuntimeLogCursorKeys,
  listServiceInstances,
  listSessions,
  readRuntimeLogCursor,
  writeRuntimeLogCursor,
} from "./metadata.js";
import { captureTmuxPane, sidecarTmuxSession, tmuxSessionExists } from "./runtime-tmux.js";
import type { AppConfig, RuntimeLogKind, SessionRecord } from "./types.js";

const RUNTIME_LOG_TAIL_LINES = 80;
const RUNTIME_LOG_POLL_INTERVAL_MS = 1_000;

interface RuntimeLogTarget {
  kind: RuntimeLogKind;
  key: string;
  name: string;
  projectId: string;
  sessionId: string;
  tmuxSession: string;
}

export interface RuntimeLogCollector {
  stop(): void;
}

function runtimeTargetKey(kind: RuntimeLogKind, name: string): string {
  return `${kind}:${name}`;
}

function enumerateSidecars(config: AppConfig, session: SessionRecord): RuntimeLogTarget[] {
  const project = config.projects[session.project];
  if (!project) {
    return [];
  }
  return Object.keys(project.sidecars).map((name) => ({
    kind: "sidecar" as const,
    key: runtimeTargetKey("sidecar", name),
    name,
    projectId: session.project,
    sessionId: session.id,
    tmuxSession: sidecarTmuxSession(session.id, name),
  }));
}

function enumerateTargets(config: AppConfig): RuntimeLogTarget[] {
  const targets: RuntimeLogTarget[] = [];
  for (const session of listSessions(config.dataDir)) {
    targets.push(...enumerateSidecars(config, session));
  }
  for (const service of listServiceInstances(config.dataDir)) {
    targets.push({
      kind: "service",
      key: runtimeTargetKey("service", service.serviceId),
      name: service.serviceId,
      projectId: service.project,
      sessionId: service.sessionId,
      tmuxSession: service.tmuxSession,
    });
  }
  return targets;
}

function logRuntimeLine(config: AppConfig, target: RuntimeLogTarget, line: string): void {
  logSpurEvent(config.dataDir, {
    event: `${target.kind}.output`,
    level: "info",
    sessionId: target.sessionId,
    projectId: target.projectId,
    message: line,
    details: target.kind === "service" ? { serviceId: target.name } : { sidecarName: target.name },
  });
}

export function startRuntimeLogCollector(config: AppConfig): RuntimeLogCollector {
  let stopped = false;
  let polling = false;

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const targets = enumerateTargets(config);
      const liveKeys = new Set<string>();

      for (const target of targets) {
        liveKeys.add(`${target.sessionId}:${target.key}`);
        const alive = await tmuxSessionExists(target.tmuxSession);
        if (!alive) {
          deleteRuntimeLogCursor(config.dataDir, target.sessionId, target.key);
          continue;
        }

        const lines = normalizeLines(
          await captureTmuxPane(target.tmuxSession, RUNTIME_LOG_TAIL_LINES),
        );
        const prior = readRuntimeLogCursor(config.dataDir, target.sessionId, target.key);
        const nextLines = prior ? appendedLines(prior.lastTailLines, lines) : lines;
        for (const line of nextLines) {
          logRuntimeLine(config, target, line);
        }
        writeRuntimeLogCursor(config.dataDir, target.sessionId, target.key, {
          lastTailLines: lines,
        });
      }

      for (const stale of listRuntimeLogCursorKeys(config.dataDir)) {
        if (!liveKeys.has(`${stale.sessionId}:${stale.key}`)) {
          deleteRuntimeLogCursor(config.dataDir, stale.sessionId, stale.key);
        }
      }
    } finally {
      polling = false;
    }
  };

  const timer = startInterval(() => {
    void poll();
  }, RUNTIME_LOG_POLL_INTERVAL_MS);

  void poll();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
