import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProjectBaseDir } from "@composio/ao-core";
import type { OrchestratorConfig, ProjectConfig } from "@composio/ao-core";

export type IntegrationService = "telegram" | "jira";
export type IntegrationKind = "polling" | "listener";
export type IntegrationState = "inactive" | "starting" | "healthy" | "degraded";

export interface IntegrationIdentity {
  id: string;
  label: string;
  service: IntegrationService;
  kind: IntegrationKind;
}

export interface IntegrationHealthEntry extends IntegrationIdentity {
  active: boolean;
  connected: boolean;
  ok: boolean;
  state: IntegrationState;
  message: string;
  updatedAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

export interface IntegrationHealthSnapshot {
  version: 1;
  projectId: string;
  updatedAt: string;
  entries: IntegrationHealthEntry[];
}

interface HealthLogger {
  warn: (message: string) => void;
}

interface CreateIntegrationHealthReporterArgs {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  logger?: HealthLogger;
  now?: () => Date;
}

interface HealthStatePatch {
  active: boolean;
  connected: boolean;
  ok: boolean;
  state: IntegrationState;
  message: string;
  lastError?: string;
}

export interface IntegrationHealthReporter {
  snapshotPath: string;
  upsert(identity: IntegrationIdentity, patch: HealthStatePatch): void;
  markStarting(identity: IntegrationIdentity, message: string): void;
  markHealthy(identity: IntegrationIdentity, message: string): void;
  markDegraded(identity: IntegrationIdentity, message: string, error?: unknown): void;
  markInactive(identity: IntegrationIdentity, message: string): void;
  getSnapshot(): IntegrationHealthSnapshot;
}

function normalizeMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "status-update";
}

function toErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : error.name;
  }

  if (typeof error === "string") {
    const normalized = error.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (error == null) return undefined;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function writeSnapshotAtomic(snapshotPath: string, snapshot: IntegrationHealthSnapshot): void {
  mkdirSync(dirname(snapshotPath), { recursive: true });

  const tmpPath = `${snapshotPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, snapshotPath);
  } finally {
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
  }
}

export function createIntegrationHealthReporter(
  args: CreateIntegrationHealthReporterArgs,
): IntegrationHealthReporter {
  const now = args.now ?? (() => new Date());
  const logger = args.logger ?? console;
  const baseDir = getProjectBaseDir(args.config.configPath, args.project.path);
  const snapshotPath = join(baseDir, "integration-health.json");
  const entries = new Map<string, IntegrationHealthEntry>();

  const persistSnapshot = (): void => {
    const snapshot: IntegrationHealthSnapshot = {
      version: 1,
      projectId: args.projectId,
      updatedAt: now().toISOString(),
      entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };

    try {
      writeSnapshotAtomic(snapshotPath, snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[integration-health] Failed to write snapshot: ${msg}`);
    }
  };

  const upsert = (identity: IntegrationIdentity, patch: HealthStatePatch): void => {
    const timestamp = now().toISOString();
    const previous = entries.get(identity.id);

    const next: IntegrationHealthEntry = {
      ...identity,
      active: patch.active,
      connected: patch.connected,
      ok: patch.ok,
      state: patch.state,
      message: normalizeMessage(patch.message),
      updatedAt: timestamp,
      lastSuccessAt: previous?.lastSuccessAt,
      lastErrorAt: previous?.lastErrorAt,
      lastError: previous?.lastError,
    };

    if (patch.state === "healthy") {
      next.lastSuccessAt = timestamp;
    }

    if (patch.state === "degraded") {
      next.lastErrorAt = timestamp;
      next.lastError = patch.lastError ?? patch.message;
    }

    entries.set(identity.id, next);
    persistSnapshot();
  };

  const reporter: IntegrationHealthReporter = {
    snapshotPath,
    upsert,
    markStarting(identity, message): void {
      upsert(identity, {
        active: true,
        connected: false,
        ok: false,
        state: "starting",
        message,
      });
    },
    markHealthy(identity, message): void {
      upsert(identity, {
        active: true,
        connected: true,
        ok: true,
        state: "healthy",
        message,
      });
    },
    markDegraded(identity, message, error): void {
      upsert(identity, {
        active: true,
        connected: false,
        ok: false,
        state: "degraded",
        message,
        lastError: toErrorMessage(error),
      });
    },
    markInactive(identity, message): void {
      upsert(identity, {
        active: false,
        connected: false,
        ok: false,
        state: "inactive",
        message,
      });
    },
    getSnapshot(): IntegrationHealthSnapshot {
      return {
        version: 1,
        projectId: args.projectId,
        updatedAt: now().toISOString(),
        entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
      };
    },
  };

  return reporter;
}
