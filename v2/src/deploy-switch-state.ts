import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DeploySwitchState =
  | {
      phase: "running";
      version: string;
      pid: number;
      processStartTime: string;
      startedAt: string;
    }
  | {
      phase: "succeeded" | "failed";
      version: string;
      pid: number;
      startedAt: string;
      finishedAt: string;
      exitCode: number;
    };

export function deploySwitchStatePath(dataDir: string): string {
  return join(dataDir, "deploy-switch.json");
}

function isState(value: unknown): value is DeploySwitchState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (
    typeof state.version !== "string" ||
    typeof state.pid !== "number" ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0 ||
    typeof state.startedAt !== "string"
  ) {
    return false;
  }
  if (state.phase === "running") return typeof state.processStartTime === "string";
  return (
    (state.phase === "succeeded" || state.phase === "failed") &&
    typeof state.finishedAt === "string" &&
    typeof state.exitCode === "number" &&
    Number.isInteger(state.exitCode)
  );
}

export function readDeploySwitchState(path: string): DeploySwitchState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDeploySwitchState(path: string, state: DeploySwitchState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}

export function readProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return null;
    return stat.slice(closeParen + 2).split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

export function reconcileDeploySwitchState(path: string): DeploySwitchState | null {
  const state = readDeploySwitchState(path);
  if (
    !state ||
    state.phase !== "running" ||
    readProcessStartTime(state.pid) === state.processStartTime
  ) {
    return state;
  }
  const failed: DeploySwitchState = {
    ...state,
    phase: "failed",
    finishedAt: new Date().toISOString(),
    exitCode: -1,
  };
  writeDeploySwitchState(path, failed);
  return failed;
}
