import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getProjectBaseDir, loadConfig } from "@composio/ao-core";
import {
  INTEGRATION_STATUS_KEYS,
  type IntegrationStatusEntry,
  type IntegrationStatusKey,
  type IntegrationStatusState,
  type IntegrationsStatusSnapshot,
} from "./types";

type JsonRecord = Record<string, unknown>;

const DEFAULT_FALLBACK_MESSAGE = "Health snapshot is not available";

const KEY_ALIASES: Record<IntegrationStatusKey, readonly string[]> = {
  telegramInboundPolling: [
    "telegramInboundPolling",
    "telegram",
    "telegramPolling",
    "telegram_inbound_polling",
  ],
  jiraCommentPolling: [
    "jiraCommentPolling",
    "jiraComments",
    "jiraPolling",
    "jira_comment_polling",
  ],
  trackerTriggerListeners: [
    "trackerTriggerListeners",
    "jiraTriggerListeners",
    "triggerListeners",
    "listeners",
    "trackerListeners",
    "tracker_trigger_listeners",
    "jiraListeners",
    "jira_trigger_listeners",
  ],
};

const STATUS_KEYS = [
  "state",
  "status",
  "phase",
  "active",
  "enabled",
  "running",
  "connected",
  "available",
  "ok",
  "healthy",
  "success",
] as const;

const STATE_ALIASES: Record<IntegrationStatusState, readonly string[]> = {
  inactive: ["inactive", "disabled", "stopped", "off"],
  starting: ["starting", "initializing", "booting", "warming"],
  healthy: ["healthy", "ok", "ready", "running", "active", "enabled", "connected"],
  degraded: ["degraded", "error", "failed", "unhealthy", "disconnected"],
  unknown: ["unknown"],
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function toNullableString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : null;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function toNullableLower(value: unknown): string | null {
  const str = toNullableString(value);
  return str ? str.toLowerCase() : null;
}

function normalizeState(value: unknown): IntegrationStatusState | null {
  const normalized = toNullableLower(value);
  if (!normalized) return null;

  for (const [state, aliases] of Object.entries(STATE_ALIASES) as Array<
    [IntegrationStatusState, readonly string[]]
  >) {
    if (aliases.includes(normalized)) return state;
  }

  return null;
}

function deriveBooleansFromState(
  state: IntegrationStatusState | null,
): { active: boolean; connected: boolean; ok: boolean } | null {
  switch (state) {
    case "healthy":
      return { active: true, connected: true, ok: true };
    case "starting":
      return { active: true, connected: false, ok: false };
    case "degraded":
      return { active: true, connected: false, ok: false };
    case "inactive":
    case "unknown":
      return { active: false, connected: false, ok: false };
    default:
      return null;
  }
}

function hasStatusSignal(entry: JsonRecord): boolean {
  return STATUS_KEYS.some((key) => key in entry);
}

function pickObjectField(source: JsonRecord, candidates: readonly string[]): unknown {
  for (const key of candidates) {
    if (key in source) return source[key];
  }
  return undefined;
}

function buildIntegrations(
  builder: (key: IntegrationStatusKey) => IntegrationStatusEntry,
): Record<IntegrationStatusKey, IntegrationStatusEntry> {
  const integrations = {} as Record<IntegrationStatusKey, IntegrationStatusEntry>;
  for (const key of INTEGRATION_STATUS_KEYS) {
    integrations[key] = builder(key);
  }
  return integrations;
}

function buildFallbackEntry(message: string): IntegrationStatusEntry {
  return {
    active: false,
    connected: false,
    ok: false,
    state: "unknown",
    message,
  };
}

export function fallbackIntegrationsStatus(
  message = DEFAULT_FALLBACK_MESSAGE,
  snapshotPath: string | null = null,
): IntegrationsStatusSnapshot {
  return {
    updatedAt: null,
    source: "fallback",
    snapshotPath,
    integrations: buildIntegrations(() => buildFallbackEntry(message)),
  };
}

function normalizeEntry(raw: unknown): IntegrationStatusEntry {
  if (typeof raw === "boolean") {
    return {
      active: raw,
      connected: raw,
      ok: raw,
      state: raw ? "healthy" : "inactive",
      message: null,
    };
  }

  if (!isRecord(raw)) {
    return {
      active: false,
      connected: false,
      ok: false,
      state: "unknown",
      message: null,
    };
  }

  if (!hasStatusSignal(raw)) {
    return {
      active: false,
      connected: false,
      ok: false,
      state: "unknown",
      message: null,
    };
  }

  const normalizedState =
    normalizeState(raw["state"]) ??
    normalizeState(raw["status"]) ??
    normalizeState(raw["phase"]);
  const fromState = deriveBooleansFromState(normalizedState);

  const active =
    toBooleanOrNull(raw["active"]) ??
    toBooleanOrNull(raw["enabled"]) ??
    toBooleanOrNull(raw["running"]) ??
    fromState?.active ??
    false;

  const connected =
    toBooleanOrNull(raw["connected"]) ??
    toBooleanOrNull(raw["available"]) ??
    fromState?.connected ??
    active;

  const ok =
    toBooleanOrNull(raw["ok"]) ??
    toBooleanOrNull(raw["healthy"]) ??
    toBooleanOrNull(raw["success"]) ??
    fromState?.ok ??
    (active && connected);

  const resolvedState: IntegrationStatusState =
    normalizedState ?? (active ? (ok ? "healthy" : "degraded") : "inactive");

  const message =
    toNullableString(raw["message"]) ??
    toNullableString(raw["detail"]) ??
    toNullableString(raw["error"]);

  return {
    active,
    connected,
    ok,
    state: resolvedState,
    message,
  };
}

function getPathsFromConfig(): string[] {
  try {
    const explicitConfigPath = toNullableString(process.env["AO_CONFIG_PATH"]);
    const config = explicitConfigPath ? loadConfig(explicitConfigPath) : loadConfig();
    const preferredProjectId = toNullableString(process.env["AO_PROJECT_ID"]);
    const projectIds = Object.keys(config.projects);

    const orderedProjectIds = preferredProjectId && projectIds.includes(preferredProjectId)
      ? [preferredProjectId, ...projectIds.filter((id) => id !== preferredProjectId)]
      : projectIds;

    return orderedProjectIds.map((projectId) => {
      const project = config.projects[projectId];
      const baseDir = getProjectBaseDir(config.configPath, project.path);
      return join(baseDir, "integration-health.json");
    });
  } catch {
    return [];
  }
}

function getConfigDir(): string {
  const configPath = toNullableString(process.env["AO_CONFIG_PATH"]);
  return configPath ? dirname(configPath) : process.cwd();
}

function resolveSnapshotCandidate(value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(getConfigDir(), value);
}

function appendUniquePaths(target: string[], candidates: string[]): void {
  for (const candidate of candidates) {
    if (!target.includes(candidate)) {
      target.push(candidate);
    }
  }
}

function getCandidateSnapshotPaths(): string[] {
  const envCandidates = [
    process.env["AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH"],
    process.env["AO_HEALTH_SNAPSHOT_PATH"],
    process.env["AO_INTEGRATIONS_STATUS_PATH"],
  ]
    .map((value) => toNullableString(value))
    .filter((value): value is string => Boolean(value));

  const allCandidates: string[] = [];
  appendUniquePaths(allCandidates, envCandidates.map((value) => resolveSnapshotCandidate(value)));
  const fromConfig = getPathsFromConfig();
  appendUniquePaths(allCandidates, fromConfig);

  const configDir = getConfigDir();
  appendUniquePaths(allCandidates, [
    join(configDir, ".ao-integrations-health.json"),
    join(configDir, ".ao-health-snapshot.json"),
    join(configDir, ".ao", "integrations-status.json"),
    join(configDir, ".ao", "health", "integrations-status.json"),
    join(configDir, "integrations-status.json"),
  ]);

  return allCandidates;
}

function findSnapshotPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? null;
}

function selectRawIntegrations(payload: JsonRecord): JsonRecord | null {
  const integrations = payload["integrations"];
  if (isRecord(integrations)) return integrations;

  const statuses = payload["statuses"];
  if (isRecord(statuses)) return statuses;

  const services = payload["services"];
  if (isRecord(services)) return services;

  return null;
}

function selectEntries(payload: JsonRecord): JsonRecord[] {
  const entries = payload["entries"];
  if (!Array.isArray(entries)) return [];

  const results: JsonRecord[] = [];
  for (const entry of entries) {
    if (isRecord(entry)) results.push(entry);
  }
  return results;
}

function pickFirstByPredicate(entries: JsonRecord[], predicate: (entry: JsonRecord) => boolean): JsonRecord | null {
  for (const entry of entries) {
    if (predicate(entry)) return entry;
  }
  return null;
}

function buildFromEntries(entries: JsonRecord[]): Record<IntegrationStatusKey, IntegrationStatusEntry> {
  const telegramPolling =
    pickFirstByPredicate(entries, (entry) => toNullableLower(entry["id"]) === "telegram-polling") ??
    pickFirstByPredicate(entries, (entry) => {
      const service = toNullableLower(entry["service"]);
      const kind = toNullableLower(entry["kind"]);
      return service === "telegram" && kind === "polling";
    });

  const jiraCommentPolling =
    pickFirstByPredicate(entries, (entry) => toNullableLower(entry["id"]) === "jira-comment-polling") ??
    pickFirstByPredicate(entries, (entry) => {
      const service = toNullableLower(entry["service"]);
      const kind = toNullableLower(entry["kind"]);
      return service === "jira" && kind === "polling";
    });

  const trackerListenerEntries = entries.filter((entry) => {
    const kind = toNullableLower(entry["kind"]);
    const service = toNullableLower(entry["service"]);
    const id = toNullableLower(entry["id"]);
    if (kind !== "listener") return false;
    if (service === "tracker" || service === "jira") return true;
    return typeof id === "string" && (id.startsWith("listener:tracker") || id.startsWith("listener:jira"));
  });

  const listenersEntry: IntegrationStatusEntry = (() => {
    if (trackerListenerEntries.length === 0) {
      return {
        active: false,
        connected: false,
        ok: false,
        state: "inactive",
        message: "No tracker trigger listeners configured",
      };
    }

    const normalized = trackerListenerEntries.map((entry) => normalizeEntry(entry));
    const total = normalized.length;
    const activeCount = normalized.filter((entry) => entry.active).length;
    const connectedCount = normalized.filter((entry) => entry.connected).length;
    const okCount = normalized.filter((entry) => entry.ok).length;

    const active = activeCount > 0;
    const connected = connectedCount === total;
    const ok = okCount === total;

    const firstProblem = normalized.find((entry) => !entry.ok || !entry.connected);

    return {
      active,
      connected,
      ok,
      state: ok ? "healthy" : active ? "degraded" : "inactive",
      message:
        ok
          ? `${total} listener(s) healthy`
          : firstProblem?.message ?? `${okCount}/${total} listener(s) healthy`,
    };
  })();

  return {
    telegramInboundPolling: normalizeEntry(telegramPolling),
    jiraCommentPolling: normalizeEntry(jiraCommentPolling),
    trackerTriggerListeners: listenersEntry,
  };
}

export function readIntegrationsStatusSnapshot(): IntegrationsStatusSnapshot {
  const candidates = getCandidateSnapshotPaths();
  const snapshotPath = findSnapshotPath(candidates);

  if (!snapshotPath || !existsSync(snapshotPath)) {
    return fallbackIntegrationsStatus(DEFAULT_FALLBACK_MESSAGE, snapshotPath);
  }

  let payload: string;
  try {
    payload = readFileSync(snapshotPath, "utf-8");
  } catch {
    return fallbackIntegrationsStatus("Health snapshot is not readable", snapshotPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return fallbackIntegrationsStatus("Health snapshot is invalid JSON", snapshotPath);
  }

  if (!isRecord(parsed)) {
    return fallbackIntegrationsStatus("Health snapshot has invalid format", snapshotPath);
  }

  const updatedAt =
    toNullableString(parsed["updatedAt"]) ??
    toNullableString(parsed["timestamp"]) ??
    toNullableString(parsed["generatedAt"]);

  const entries = selectEntries(parsed);
  if (entries.length > 0) {
    return {
      updatedAt,
      source: "snapshot",
      snapshotPath,
      integrations: buildFromEntries(entries),
    };
  }

  const rawIntegrations = selectRawIntegrations(parsed);
  if (!rawIntegrations) {
    return fallbackIntegrationsStatus("Health snapshot has no integrations payload", snapshotPath);
  }

  const integrations = buildIntegrations((key) => {
    const rawEntry = pickObjectField(rawIntegrations, KEY_ALIASES[key]);
    return normalizeEntry(rawEntry);
  });

  return {
    updatedAt,
    source: "snapshot",
    snapshotPath,
    integrations,
  };
}
