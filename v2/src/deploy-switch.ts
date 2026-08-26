import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import {
  readDeploySwitchState,
  readProcessStartTime,
  reconcileDeploySwitchState,
  writeDeploySwitchState,
  type DeployInitiator,
} from "./deploy-switch-state.js";
import { getReleases, isReleaseVersion } from "./releases-cache.js";
import { getVersion } from "./version.js";

// The single executor for a version switch, shared by the human `POST
// /deploy/switch` route and the auto-update tick (`auto-update.ts`). Every
// guard lives here so the auto path inherits the same contract as the human
// press: the semver check, the in-progress 409, the source-checkout guard,
// the registry membership check, the durable status write, and both
// `install-and-restart.sh` rollback branches. The disarm of `autoUpdate`
// deliberately does NOT live here — it is a route-level concern (see
// `server.ts`), so the auto path can never disarm itself on its first run.

export type DeploySwitchResult =
  | { status: "accepted"; version: string }
  | { status: "already_current"; version: string }
  | { status: "invalid_version" }
  | { status: "in_progress"; version: string }
  | { status: "source_checkout" }
  | { status: "registry_unreachable" }
  | { status: "not_in_registry" }
  | { status: "spawn_failed"; message: string };

export async function startDeploySwitch(args: {
  version: string;
  initiator: DeployInitiator;
  statePath: string;
  ledgerPath: string;
}): Promise<DeploySwitchResult> {
  const { version, initiator, statePath, ledgerPath } = args;
  if (!isReleaseVersion(version)) {
    return { status: "invalid_version" };
  }

  const activeSwitch = reconcileDeploySwitchState(statePath);
  if (activeSwitch?.phase === "running") {
    return { status: "in_progress", version: activeSwitch.version };
  }

  // Guard: refuse to run when the daemon is executing from a source checkout
  // (e.g. `tsx`/`node v2/dist/cli.js` outside `node_modules`). Tests opt in
  // via SPUR_DEPLOY_SWITCH_FORCE=1.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const forceSwitch = process.env["SPUR_DEPLOY_SWITCH_FORCE"] === "1";
  if (!forceSwitch && !here.includes("/node_modules/@shugaev/spur/")) {
    return { status: "source_checkout" };
  }

  const releases = await getReleases();
  if (!releases.entries.some((entry) => entry.tag === version)) {
    if (releases.entries.length === 0 && releases.error) {
      return { status: "registry_unreachable" };
    }
    return { status: "not_in_registry" };
  }

  if (version === getVersion()) {
    return { status: "already_current", version };
  }

  const helperPath = fileURLToPath(new URL("../scripts/install-and-restart.sh", import.meta.url));
  const child = spawn("bash", [helperPath, version], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SPUR_INSTALL_STATUS_FILE: statePath,
      SPUR_DEPLOY_INITIATOR: initiator,
      SPUR_UPDATE_LEDGER_FILE: ledgerPath,
    },
  });
  if (child.pid === undefined) {
    return { status: "spawn_failed", message: "failed to start deploy switch" };
  }
  const pid = child.pid;
  const startedAt = new Date().toISOString();
  const processStartTime = readProcessStartTime(pid);
  if (!processStartTime) {
    return { status: "spawn_failed", message: "failed to identify deploy switch process" };
  }
  writeDeploySwitchState(statePath, {
    phase: "running",
    version,
    pid,
    processStartTime,
    initiator,
    startedAt,
  });
  // The helper writes its own terminal status, but only after it arms the
  // trap: this covers a spawn error and the exit before that (bad version —
  // the only pre-trap exit left; a lock timeout now runs under the armed
  // trap and writes its own install_failed record). The helper's write is
  // authoritative when it exists — it
  // is the only process that knows which branch it took, so it is the only
  // one that can set `failureKind`. Its EXIT trap runs before the process
  // exits, so this handler normally observes that record; overwriting it
  // would erase the kind and make a rolled-back version look retryable.
  const finishSwitch = (exitCode: number): void => {
    const current = readDeploySwitchState(statePath);
    if (
      current &&
      current.phase !== "running" &&
      current.version === version &&
      current.pid === pid
    ) {
      return;
    }
    writeDeploySwitchState(statePath, {
      phase: exitCode === 0 ? "succeeded" : "failed",
      version,
      pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      initiator,
    });
  };
  child.once("error", () => finishSwitch(-1));
  child.once("exit", (code) => finishSwitch(code ?? -1));
  child.unref();

  return { status: "accepted", version };
}
