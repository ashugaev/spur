import { logSpurEvent } from "./event-log.js";
import { captureTmuxPane, sidecarTmuxAlive, sidecarTmuxSession } from "./runtime-tmux.js";
import { normalizeLines, updateServiceSourceState } from "./event-sources/service.js";
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
    return { ok: true, matchedRules: [] };
  }
  const project = args.service.config.projects[session.project];
  if (!project) {
    return { ok: true, matchedRules: [] };
  }
  if (!(await sidecarTmuxAlive(args.sessionId, args.sidecarName))) {
    return { ok: true, matchedRules: [] };
  }

  const sources = Object.entries(project.sources).filter(
    (entry): entry is [string, ServiceSourceConfig] =>
      isSidecarServiceSource(entry[1], args.sidecarName),
  );
  if (sources.length === 0) {
    return { ok: true, matchedRules: [] };
  }

  const maxTailLines = Math.max(...sources.map(([, source]) => source.tailLines));
  const tailLines = normalizeLines(
    await captureTmuxPane(sidecarTmuxSession(args.sessionId, args.sidecarName), maxTailLines),
  );
  const matchedRules: SidecarLogReportResult["matchedRules"] = [];

  for (const [sourceId, source] of sources) {
    const scopedTailLines = tailLines.slice(-source.tailLines);
    const evaluation = await updateServiceSourceState({
      dataDir: args.service.config.dataDir,
      projectId: session.project,
      sourceId,
      sessionId: args.sessionId,
      config: source,
      tailLines: scopedTailLines,
      candidateLines: () => scopedTailLines,
      nowMs: Date.now(),
      mode: "normal",
    });
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

  return { ok: true, matchedRules };
}
