import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type MonitorRef = { kind: "systemd"; unit: string } | { kind: "process"; pid: number };

export type UpdatePhase = "installing" | "monitoring" | "rolling-back";

export interface LastKnownGood {
  version: string;
  healthyAt: string;
}

export interface UpdateInProgress {
  fromVersion: string;
  toVersion: string;
  monitor: MonitorRef | null;
  startedAt: string;
  phase: UpdatePhase;
}

export interface UpdateFailure {
  fromVersion: string;
  toVersion: string;
  startedAt: string;
  finishedAt: string;
  stage: "install" | "reinit";
  installedVersion: string | null;
  exitCode: number | null;
}

export interface RollbackState {
  version: 1;
  lastKnownGood: LastKnownGood | null;
  inProgress: UpdateInProgress | null;
  lastFailure?: UpdateFailure;
}

export function defaultRollbackStatePath(home = homedir()): string {
  return join(home, ".spur", "rollback-state.json");
}

export function defaultState(): RollbackState {
  return { version: 1, lastKnownGood: null, inProgress: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMonitorRef(value: unknown): value is MonitorRef {
  if (!isRecord(value)) return false;
  if (value["kind"] === "systemd") return typeof value["unit"] === "string";
  if (value["kind"] === "process") return typeof value["pid"] === "number";
  return false;
}

function isLastKnownGood(value: unknown): value is LastKnownGood {
  return (
    isRecord(value) &&
    typeof value["version"] === "string" &&
    typeof value["healthyAt"] === "string"
  );
}

function isUpdatePhase(value: unknown): value is UpdatePhase {
  return value === "installing" || value === "monitoring" || value === "rolling-back";
}

function isUpdateInProgress(value: unknown): value is UpdateInProgress {
  return (
    isRecord(value) &&
    typeof value["fromVersion"] === "string" &&
    typeof value["toVersion"] === "string" &&
    (value["monitor"] === null || isMonitorRef(value["monitor"])) &&
    typeof value["startedAt"] === "string" &&
    isUpdatePhase(value["phase"])
  );
}

function isRollbackState(value: unknown): value is Omit<RollbackState, "lastFailure"> {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    (value["lastKnownGood"] === null || isLastKnownGood(value["lastKnownGood"])) &&
    (value["inProgress"] === null || isUpdateInProgress(value["inProgress"]))
  );
}

function isUpdateFailure(value: unknown): value is UpdateFailure {
  return (
    isRecord(value) &&
    typeof value["fromVersion"] === "string" &&
    typeof value["toVersion"] === "string" &&
    typeof value["startedAt"] === "string" &&
    typeof value["finishedAt"] === "string" &&
    (value["stage"] === "install" || value["stage"] === "reinit") &&
    (value["installedVersion"] === null || typeof value["installedVersion"] === "string") &&
    (value["exitCode"] === null || Number.isInteger(value["exitCode"]))
  );
}

// Boundary read: a missing, unreadable, or malformed state file resets to the
// default rather than crashing the CLI or a detached monitor.
export function readState(path: string): RollbackState {
  if (!existsSync(path)) {
    return defaultState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return defaultState();
  }
  const lastFailure = isRecord(parsed) ? parsed["lastFailure"] : undefined;
  if (!isRollbackState(parsed)) {
    return defaultState();
  }
  return {
    version: parsed.version,
    lastKnownGood: parsed.lastKnownGood,
    inProgress: parsed.inProgress,
    ...(isUpdateFailure(lastFailure) ? { lastFailure } : {}),
  };
}

export function writeState(path: string, state: RollbackState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

export interface MonitorLiveProbes {
  pidAlive(pid: number): boolean;
  unitActive(unit: string): boolean;
}

export function isMonitorLive(ref: MonitorRef | null, probes: MonitorLiveProbes): boolean {
  if (ref === null) return false;
  if (ref.kind === "systemd") return probes.unitActive(ref.unit);
  return probes.pidAlive(ref.pid);
}
