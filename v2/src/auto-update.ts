import { compareSemverDesc, type ReleasesResult } from "./releases-cache.js";
import type { ReadAutoUpdateFlagResult } from "./auto-update-config.js";
import type { DeploySwitchResult } from "./deploy-switch.js";
import type { DeployFailureKind, DeploySwitchState } from "./deploy-switch-state.js";
import type { SpurLogEntry } from "./event-log.js";

// The auto-update decision, pure apart from injected deps — mirrors
// update-decision.ts. No disk or network of its own, so it is unit-testable
// without a daemon. Every guard `startDeploySwitch` owns is NOT repeated
// here; this module only decides whether to call it and suppresses a
// repeat attempt at the same candidate.

// The kinds that say the install already changed the host: another attempt
// would repeat a real install plus a real rollback, every tick, forever. A
// kind that never installed anything — and a record with no kind at all — is
// retried instead.
function isNoRetryKind(kind: DeployFailureKind | undefined): boolean {
  return kind === "rolled_back" || kind === "install_unhealthy";
}

export interface RunAutoUpdateTickDeps {
  configPath: string;
  statePath: string;
  currentVersion: string;
  readFlag: (path: string) => ReadAutoUpdateFlagResult;
  readState: (path: string) => DeploySwitchState | null;
  getReleases: () => Promise<ReleasesResult>;
  start: (version: string) => Promise<DeploySwitchResult>;
  log: (event: string, entry: Omit<SpurLogEntry, "timestamp" | "event">) => void;
}

export async function runAutoUpdateTick(deps: RunAutoUpdateTickDeps): Promise<void> {
  const { configPath, statePath, currentVersion, readFlag, readState, getReleases, start, log } =
    deps;

  // First, before any network call, so a default (autoUpdate: false) install
  // never touches the registry.
  const flag = readFlag(configPath);
  if (flag.error) {
    log("daemon.auto_update.config_invalid", { level: "warn", message: flag.error });
  }
  if (!flag.autoUpdate) return;

  // `readState` is expected to be `reconcileDeploySwitchState`: a dead pid
  // is reconciled to `failed` here exactly as it is for the route.
  const state = readState(statePath);
  if (state?.phase === "running") return;

  const releases = await getReleases();
  const candidate = releases.entries[0];
  if (!candidate) return;

  // "Strictly newer": compareSemverDesc sorts descending, so a negative
  // result means the candidate sorts before currentVersion, i.e. it is
  // greater. `getVersion()`'s `--always` fallback with no matching tags at
  // all returns a bare abbreviated SHA (no dots); Number.parseInt on its
  // leading non-digit character yields NaN, and every NaN comparison is
  // false, so this test fails closed rather than treating an untagged
  // source checkout as always-behind. A describe string rooted at a real
  // tag inherits that tag's numbers and compares like an ordinary release.
  if (!(compareSemverDesc(candidate.tag, currentVersion) < 0)) return;

  // Retry suppression, by recorded kind. A terminal record naming this exact
  // candidate suppresses it only when another attempt cannot help:
  // `succeeded` (install-and-restart.sh can exit 0 without restarting the
  // daemon — e.g. systemctl absent — leaving a `succeeded` record for a
  // candidate still newer than the running version), or a failure kind that
  // says the package installed and left the host changed. A failure that
  // installed nothing, or one with no recorded kind at all, is attempted
  // again on every tick with no cap: the reported bug was a transient
  // registry error stranding a host on the old version forever, silently.
  // A human press is unaffected either way: this branch lives in the tick,
  // not in `startDeploySwitch`. `state` is guaranteed terminal here (the
  // `phase === "running"` branch above already returned).
  if (state && state.version === candidate.tag) {
    if (state.phase === "succeeded" || isNoRetryKind(state.failureKind)) {
      log("daemon.auto_update.suppressed", {
        level: "warn",
        details: {
          version: candidate.tag,
          phase: state.phase,
          failureKind: state.failureKind,
          initiator: state.initiator,
          reason: state.phase === "succeeded" ? "succeeded_record" : "no_retry_kind",
        },
      });
      return;
    }
    log("daemon.auto_update.retry", {
      level: "info",
      details: {
        version: candidate.tag,
        failureKind: state.failureKind,
        previousExitCode: state.exitCode,
      },
    });
  }

  const result = await start(candidate.tag);
  if (result.status === "accepted") {
    log("daemon.auto_update.started", { level: "info", details: { version: candidate.tag } });
  } else {
    log("daemon.auto_update.skipped", {
      level: "info",
      details: { status: result.status, version: candidate.tag },
    });
  }
}
