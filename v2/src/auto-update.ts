import { compareSemverDesc, type ReleasesResult } from "./releases-cache.js";
import type { DeploySwitchResult } from "./deploy-switch.js";
import type { DeploySwitchState } from "./deploy-switch-state.js";
import type { SpurLogEntry } from "./event-log.js";

// The auto-update decision, pure apart from injected deps — mirrors
// update-decision.ts. No disk or network of its own, so it is unit-testable
// without a daemon. Every guard `startDeploySwitch` owns is NOT repeated
// here; this module only decides whether to call it and suppresses a
// repeat attempt at the same candidate.

export interface RunAutoUpdateTickDeps {
  configPath: string;
  statePath: string;
  currentVersion: string;
  readFlag: (path: string) => { autoUpdate: boolean; error: string | null };
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
  // source checkout as always-behind. (A git-describe string built on top
  // of a real tag instead inherits that tag's own numeric components and
  // compares like an ordinary release rooted at that tag — this guard is
  // specifically about the no-tags-at-all case.)
  if (!(compareSemverDesc(candidate.tag, currentVersion) < 0)) return;

  // Retry suppression: any terminal record naming this exact candidate
  // suppresses it, whether it succeeded or failed. `failed` alone is not
  // enough — install-and-restart.sh can exit 0 without actually restarting
  // the daemon (e.g. systemctl absent), leaving a `succeeded` record for a
  // candidate that is still newer than the running version. A human press
  // is unaffected: this branch lives in the tick, not in `startDeploySwitch`.
  // `state` is guaranteed terminal here (the `phase === "running"` branch
  // above already returned), so no further phase check is needed.
  if (state && state.version === candidate.tag) {
    return;
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
