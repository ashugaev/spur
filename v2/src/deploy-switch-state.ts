import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Who asked for this switch: the auto-update tick or a human press
// (`POST /deploy/switch`, and later the `spur update` CLI). Required on both
// arms so a record can never be mistaken for the other initiator.
export type DeployInitiator = "auto" | "manual";

// What the failed attempt did to the host, recorded by whichever process
// took that branch and never re-derived from `exitCode` afterwards:
//   install_failed    — the target never installed. Retryable.
//   rolled_back       — the target installed, failed, previous version restored.
//   install_unhealthy — the target installed, failed, NOT restored.
// The last two are never auto-retried: the install already changed the host,
// so another attempt repeats a real install plus a real rollback.
export type DeployFailureKind = "install_failed" | "rolled_back" | "install_unhealthy";

export type DeploySwitchState =
  | {
      phase: "running";
      version: string;
      pid: number;
      processStartTime: string;
      startedAt: string;
      initiator: DeployInitiator;
    }
  | {
      phase: "succeeded" | "failed";
      version: string;
      pid: number;
      startedAt: string;
      finishedAt: string;
      exitCode: number;
      initiator: DeployInitiator;
      failureKind?: DeployFailureKind;
    };

export function deploySwitchStatePath(dataDir: string): string {
  return join(dataDir, "deploy-switch.json");
}

function isInitiator(value: unknown): value is DeployInitiator {
  return value === "auto" || value === "manual";
}

function isFailureKind(value: unknown): value is DeployFailureKind {
  return value === "install_failed" || value === "rolled_back" || value === "install_unhealthy";
}

function isState(value: unknown): value is DeploySwitchState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (
    typeof state.version !== "string" ||
    typeof state.pid !== "number" ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0 ||
    typeof state.startedAt !== "string" ||
    // No back-compat shim: a record written before `initiator` existed reads
    // back as `null`, i.e. "no prior attempt", so it suppresses nothing.
    !isInitiator(state.initiator)
  ) {
    return false;
  }
  if (state.phase === "running") return typeof state.processStartTime === "string";
  return (
    (state.phase === "succeeded" || state.phase === "failed") &&
    typeof state.finishedAt === "string" &&
    typeof state.exitCode === "number" &&
    Number.isInteger(state.exitCode) &&
    (state.failureKind === undefined || isFailureKind(state.failureKind))
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
