import { logSpurEvent } from "./event-log.js";
import { readServiceSourceState, writeServiceSourceState } from "./metadata.js";
import { captureTmuxPane, sidecarTmuxAlive, sidecarTmuxSession } from "./runtime-tmux.js";
import { evaluateServiceSourceState, normalizeLines } from "./event-sources/service.js";
import type { EventBus } from "./event-bus.js";
import type { SessionService } from "./session-service.js";
import type { ServiceProblemEventData, ServiceSourceConfig } from "./types.js";

export interface SidecarLogReportResult {
  ok: true;
  matchedRules: Array<{
    sourceId: string;
    ruleId: string;
  }>;
}

function isSidecarServiceSource(
  source: unknown,
  sidecarName: string,
): source is ServiceSourceConfig {
  const record = source as Record<string, unknown>;
  return (
    typeof source === "object" &&
    source !== null &&
    record["type"] === "service" &&
    record["targetKind"] === "sidecar" &&
    record["service"] === sidecarName
  );
}

export async function reportSidecarLogFailure(args: {
  service: SessionService;
  bus: EventBus;
  sessionId: string;
  sidecarName: string;
}): Promise<SidecarLogReportResult> {
  const session = await args.service.get(args.sessionId);
  if (session.status !== "running") {
    throw new Error(`Session is not running: ${args.sessionId}`);
  }
  const project = args.service.config.projects[session.project];
  if (!project) {
    throw new Error(`Project not found: ${session.project}`);
  }
  if (!(await sidecarTmuxAlive(args.sessionId, args.sidecarName))) {
    throw new Error(`Sidecar is not running: ${args.sidecarName}`);
  }

  const sources = Object.entries(project.sources).filter(
    (entry): entry is [string, ServiceSourceConfig] =>
      isSidecarServiceSource(entry[1], args.sidecarName),
  );
  if (sources.length === 0) {
    throw new Error(
      `Project ${session.project} has no sidecar log source for "${args.sidecarName}"`,
    );
  }

  const maxTailLines = Math.max(...sources.map(([, source]) => source.tailLines));
  const tailLines = normalizeLines(
    await captureTmuxPane(sidecarTmuxSession(args.sessionId, args.sidecarName), maxTailLines),
  );
  const matchedRules: SidecarLogReportResult["matchedRules"] = [];

  for (const [sourceId, source] of sources) {
    const scopedTailLines = tailLines.slice(-source.tailLines);
    const previous = readServiceSourceState(
      args.service.config.dataDir,
      session.project,
      sourceId,
      args.sessionId,
    );
    const evaluation = evaluateServiceSourceState({
      config: source,
      previous,
      tailLines: scopedTailLines,
      candidateLines: scopedTailLines,
      nowMs: Date.now(),
      mode: "force",
    });
    writeServiceSourceState(
      args.service.config.dataDir,
      session.project,
      sourceId,
      args.sessionId,
      evaluation.state,
    );
    for (const ruleId of evaluation.matchedRuleIds) {
      const data: ServiceProblemEventData = {
        sessionId: args.sessionId,
        serviceId: args.sidecarName,
        runtimeKind: "sidecar",
        ruleId,
      };
      logSpurEvent(args.service.config.dataDir, {
        event: "source.event.emitted",
        level: "info",
        projectId: session.project,
        sourceId,
        sessionId: args.sessionId,
        message: `Emitted service:${ruleId} from ${session.project}/${sourceId}`,
        details: {
          eventName: `service:${ruleId}`,
          type: source.type,
          manual: true,
        },
      });
      args.bus.emit({
        name: `service:${ruleId}`,
        projectId: session.project,
        sourceId,
        data,
      });
      matchedRules.push({ sourceId, ruleId });
    }
  }

  if (matchedRules.length === 0) {
    throw new Error(`No configured sidecar log rule matched recent output for ${args.sidecarName}`);
  }

  return { ok: true, matchedRules };
}
