import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Who asked for this switch: the auto-update tick or a human press
// (`POST /deploy/switch`, and later the `spur update` CLI). Required on both
// arms so a record can never be mistaken for the other initiator.
export type DeployInitiator = "auto" | "manual";

// What the failed attempt did to the host, recorded by whichever process
// took that branch and never re-derived from `exitCode` afterwards:
//   install_failed      — the target never installed. Retryable.
//   rolled_back         — the target installed, failed, previous version restored.
//   install_unhealthy   — the target installed, failed, NOT restored.
//   interrupted_unknown — the run died without running its own trap; whether
//                         it installed is UNKNOWN. Never auto-retried, same as
//                         the two host-changed kinds, but not one of them: no
//                         `blocked` ledger line is written for it, because the
//                         install is not proven to have changed the host.
export type DeployFailureKind =
  | "install_failed"
  | "rolled_back"
  | "install_unhealthy"
  | "interrupted_unknown";

// The two kinds that say the install PROVABLY changed the host. Named here,
// with the record's shape, because a `blocked` ledger line is written only
// for these.
export type HostChangedFailureKind = "rolled_back" | "install_unhealthy";

// Every kind that must never be auto-retried: the two host-changed kinds plus
// interrupted_unknown, whose truth is unknown rather than provably changed.
export type NoRetryFailureKind = HostChangedFailureKind | "interrupted_unknown";

export function isNoRetryFailureKind(
  kind: DeployFailureKind | undefined,
): kind is NoRetryFailureKind {
  return kind === "rolled_back" || kind === "install_unhealthy" || kind === "interrupted_unknown";
}

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
      // Set only on a succeeded record whose install skipped the restart
      // (systemctl absent). Never set alongside failureKind.
      outcome?: "restart_skipped";
    };

export function deploySwitchStatePath(dataDir: string): string {
  return join(dataDir, "deploy-switch.json");
}

function isInitiator(value: unknown): value is DeployInitiator {
  return value === "auto" || value === "manual";
}

function isFailureKind(value: unknown): value is DeployFailureKind {
  return (
    value === "install_failed" ||
    value === "rolled_back" ||
    value === "install_unhealthy" ||
    value === "interrupted_unknown"
  );
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
    (state.failureKind === undefined || isFailureKind(state.failureKind)) &&
    (state.outcome === undefined || state.outcome === "restart_skipped")
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

// The wire kind for the operator notice: everything that is never auto-retried,
// plus `restart_skipped`, whose record is `succeeded` rather than `failed`.
export type UpdateNoticeKind = NoRetryFailureKind | "restart_skipped";

// Reads a failed record whose recorded kind is never auto-retried, and only
// that record — the shared precondition for both the notice's failed branch
// and clearing. Never reads a succeeded record.
function readRollbackRecord(path: string): {
  version: string;
  failureKind: NoRetryFailureKind;
  initiator: DeployInitiator;
} | null {
  const state = readDeploySwitchState(path);
  if (!state || state.phase !== "failed" || !isNoRetryFailureKind(state.failureKind)) return null;
  return {
    version: state.version,
    failureKind: state.failureKind,
    // Carried because only an auto-initiated failure disarms the flag: the UI
    // must not claim a suspension on a host that never had `autoUpdate` on.
    initiator: state.initiator,
  };
}

// The operator's update notice, derived from the record and the running
// version alone so no `dismissed` flag can go stale. Two disjoint sources:
// a failed record whose recorded kind is never auto-retried (rollback/unknown),
// or a succeeded record that skipped the restart, staged only while the
// process is still running the old version.
export function readUpdateNotice(
  path: string,
  currentVersion: string,
): {
  version: string;
  failureKind: UpdateNoticeKind;
  initiator: DeployInitiator;
} | null {
  const rollback = readRollbackRecord(path);
  if (rollback) return rollback;
  const state = readDeploySwitchState(path);
  if (
    state &&
    state.phase === "succeeded" &&
    state.outcome === "restart_skipped" &&
    state.version !== currentVersion
  ) {
    return { version: state.version, failureKind: "restart_skipped", initiator: state.initiator };
  }
  return null;
}

// Removes the record behind the rollback notice, and only that: a `running`
// record keeps the in-progress 409 guard, and `succeeded` (including
// restart_skipped) or `install_failed` records keep driving the tick's retry
// decision. Never-retry memory does not live here — it lives in
// update-ledger.jsonl, so clearing the notice cannot re-arm a rolled-back
// version.
export function clearFailedDeploySwitchRecord(path: string): void {
  if (!readRollbackRecord(path)) return;
  rmSync(path, { force: true });
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
    failureKind: "interrupted_unknown",
  };
  writeDeploySwitchState(path, failed);
  return failed;
}
