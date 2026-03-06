import { TERMINAL_ACTIVITIES, TERMINAL_STATUSES } from "./types.js";

const TERMINAL_ACTIVITY_VALUES: ReadonlySet<string> = new Set(
  [...TERMINAL_ACTIVITIES].map((value) => value.toLowerCase()),
);
const TERMINAL_STATUS_VALUES: ReadonlySet<string> = new Set(
  [...TERMINAL_STATUSES].map((value) => value.toLowerCase()),
);

export interface OrchestratorSessionRoutingCandidate {
  id: string;
  status?: string | null;
  activity?: string | null;
  lastActivityAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SelectFallbackOrchestratorSessionOptions {
  defaultSessionId?: string | null;
  preferredOrchestratorSessionId?: string | null;
}

function normalizeOptionalSessionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOrchestratorCandidate(session: OrchestratorSessionRoutingCandidate): boolean {
  if (session.id.endsWith("-orchestrator")) return true;
  const role =
    session.metadata && typeof session.metadata["role"] === "string"
      ? session.metadata["role"].trim().toLowerCase()
      : null;
  return role === "orchestrator";
}

function isRoutableCandidate(session: OrchestratorSessionRoutingCandidate): boolean {
  const normalizedActivity = session.activity?.trim().toLowerCase();
  if (normalizedActivity && TERMINAL_ACTIVITY_VALUES.has(normalizedActivity)) {
    return false;
  }

  const normalizedStatus = session.status?.trim().toLowerCase();
  if (!normalizedStatus) return true;
  return !TERMINAL_STATUS_VALUES.has(normalizedStatus);
}

export function selectFallbackOrchestratorSessionId(
  sessions: readonly OrchestratorSessionRoutingCandidate[],
  options: SelectFallbackOrchestratorSessionOptions = {},
): string | null {
  const defaultSessionId = normalizeOptionalSessionId(options.defaultSessionId);
  if (defaultSessionId) return defaultSessionId;

  const preferredSessionId = normalizeOptionalSessionId(options.preferredOrchestratorSessionId);
  const routableOrchestrators = sessions.filter(
    (session) => isOrchestratorCandidate(session) && isRoutableCandidate(session),
  );
  if (routableOrchestrators.length === 0) return null;

  if (preferredSessionId) {
    return routableOrchestrators.some((session) => session.id === preferredSessionId)
      ? preferredSessionId
      : null;
  }

  if (routableOrchestrators.length === 1) return routableOrchestrators[0]?.id ?? null;
  return null;
}

export function coerceOrchestratorSessionRoutingCandidates(
  value: unknown,
): OrchestratorSessionRoutingCandidate[] {
  if (!Array.isArray(value)) return [];

  const candidates: OrchestratorSessionRoutingCandidate[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    if (!id) continue;

    const metadataValue = entry["metadata"];
    candidates.push({
      id,
      status:
        typeof entry["status"] === "string" || entry["status"] === null
          ? (entry["status"] as string | null)
          : undefined,
      activity:
        typeof entry["activity"] === "string" || entry["activity"] === null
          ? (entry["activity"] as string | null)
          : undefined,
      lastActivityAt:
        entry["lastActivityAt"] instanceof Date ||
        typeof entry["lastActivityAt"] === "string" ||
        entry["lastActivityAt"] === null
          ? (entry["lastActivityAt"] as Date | string | null)
          : undefined,
      metadata: isRecord(metadataValue) ? metadataValue : undefined,
    });
  }

  return candidates;
}
