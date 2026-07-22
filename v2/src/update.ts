import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { isActive, resolveSystemdScope, runNpmInit } from "./host-install.js";
import { writeStdout } from "./io.js";
import { getReleases, isReleaseVersion } from "./releases-cache.js";
import {
  DEFAULT_DECISION_CONFIG,
  evaluate,
  initialDecisionState,
  type DecisionConfig,
} from "./update-decision.js";
import {
  makeTargets,
  probe,
  readWebPort,
  readWebUnitOptions,
  SERVICE_UNITS,
  unitStateWith,
  type PollSample,
  type ProbeResult,
  type ProbeTarget,
  type ServiceId,
  type UnitState,
} from "./update-health.js";
import {
  defaultRollbackStatePath,
  isMonitorLive,
  readState,
  writeState,
  type MonitorRef,
  type RollbackState,
  type UpdateInProgress,
} from "./update-state.js";
import { version } from "./version.js";

const MONITOR_UNIT = "spur-update-monitor.service";
const PACKAGE_SPEC = "@shugaev/spur";
const DEFAULT_DAEMON_PORT = 4310;
const VERIFY_ATTEMPTS = 5;
const VERIFY_INTERVAL_MS = 3_000;

export interface RunUpdateOptions {
  version?: string;
  force?: boolean;
}

export interface UpdateDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  probe(target: ProbeTarget): Promise<ProbeResult>;
  unitState(unit: string): Promise<UnitState>;
  installVersion(target: string): void;
  reinit(): void;
  currentVersion: string;
  readInstalledVersion(): string;
  readState(): RollbackState;
  writeState(state: RollbackState): void;
  readWebPort(): number;
  readDaemonPort(): number;
  launch(): MonitorRef;
  stopMonitor(ref: MonitorRef): void;
  pidAlive(pid: number): boolean;
  unitActive(unit: string): boolean;
  log(message: string): void;
}

function readInstalledVersion(cliEntrypoint: string): string {
  const pkgPath = join(dirname(realpathSync(cliEntrypoint)), "..", "package.json");
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read installed package version at ${pkgPath}: ${message}`, {
      cause: error,
    });
  }
  if (typeof parsed.version !== "string") {
    throw new Error(`installed package.json is missing a version string at ${pkgPath}`);
  }
  return parsed.version;
}

function realLaunch(cliEntrypoint: string): MonitorRef {
  try {
    execFileSync(
      "systemd-run",
      [
        "--user",
        "--collect",
        `--unit=${MONITOR_UNIT.replace(/\.service$/, "")}`,
        process.execPath,
        cliEntrypoint,
        "update-monitor",
      ],
      { stdio: "ignore" },
    );
    return { kind: "systemd", unit: MONITOR_UNIT };
  } catch {
    const logPath = join(homedir(), ".spur", "logs", "update-monitor.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    const child = spawn(process.execPath, [cliEntrypoint, "update-monitor"], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error("failed to spawn detached update monitor");
    }
    return { kind: "process", pid: child.pid };
  }
}

function realStopMonitor(ref: MonitorRef): void {
  // Best-effort teardown of a superseded monitor; a missing unit or process is
  // exactly the outcome we want, so failures are ignored.
  if (ref.kind === "systemd") {
    try {
      execFileSync("systemctl", ["--user", "stop", ref.unit], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(ref.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

function realPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code === "EPERM"
      : false;
  }
}

// `spur update` is host-level, so resolve the daemon's listen port the same way
// the daemon does: read the bootstrap instance config, defaulting to 4310 when
// it is unset or unreadable. Otherwise a non-default `server.port` host would
// see the daemon probe as connection-refused and false-rollback a healthy update.
function resolveDaemonPort(): number {
  try {
    return loadConfig().server.port;
  } catch {
    return DEFAULT_DAEMON_PORT;
  }
}

// Reinstall the user systemd units, preserving the live web port / external
// exposure / Tailscale bind the operator deployed instead of resetting the
// units to loopback:4311. Shared by `spur update`'s reinit dep and the
// `spur reinit` CLI command so every migration path (CLI update, UI/deploy
// switch, install-and-restart.sh) converges on the same unit-reinstall logic.
export function reinitUnits(cliEntrypoint: string): void {
  const scope = resolveSystemdScope(homedir());
  const { webPort, exposeWeb, tailscale } = readWebUnitOptions(scope);
  runNpmInit(cliEntrypoint, { webPort: String(webPort), exposeWeb, tailscale });
}

export function createRealUpdateDeps(
  cliEntrypoint: string,
  statePath: string = defaultRollbackStatePath(),
): UpdateDeps {
  const scope = resolveSystemdScope(homedir());
  return {
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
    probe: (target) => probe(target),
    unitState: (unit) => unitStateWith(scope, unit),
    installVersion: (target) => {
      execFileSync("npm", ["install", "-g", `${PACKAGE_SPEC}@${target}`], { stdio: "inherit" });
    },
    reinit: () => reinitUnits(cliEntrypoint),
    currentVersion: version,
    readInstalledVersion: () => readInstalledVersion(cliEntrypoint),
    readState: () => readState(statePath),
    writeState: (state) => writeState(statePath, state),
    readWebPort: () => readWebPort(scope),
    readDaemonPort: () => resolveDaemonPort(),
    launch: () => realLaunch(cliEntrypoint),
    stopMonitor: (ref) => realStopMonitor(ref),
    pidAlive: (pid) => realPidAlive(pid),
    unitActive: (unit) => isActive(scope.ctl, unit),
    log: (message) => writeStdout(`${message}\n`),
  };
}

const SERVICE_IDS: readonly ServiceId[] = ["daemon", "web"];

async function buildSample(deps: UpdateDeps, atMs: number): Promise<PollSample> {
  const targets = makeTargets({ daemon: deps.readDaemonPort(), web: deps.readWebPort() });
  const [[daemonH, webH], [daemonU, webU]] = await Promise.all([
    Promise.all([deps.probe(targets.daemon), deps.probe(targets.web)]),
    Promise.all([deps.unitState(SERVICE_UNITS.daemon), deps.unitState(SERVICE_UNITS.web)]),
  ]);
  return {
    atMs,
    health: { daemon: daemonH, web: webH },
    units: { daemon: daemonU, web: webU },
  };
}

function assertNotSourceCheckout(): void {
  if (process.env["SPUR_UPDATE_FORCE"] === "1") return;
  const here = fileURLToPath(new URL(".", import.meta.url));
  if (!here.includes(`/node_modules/${PACKAGE_SPEC}/`)) {
    throw new Error(
      "spur update refuses to run from a source checkout; use the repo deploy flow or set SPUR_UPDATE_FORCE=1",
    );
  }
}

async function resolveTargetVersion(versionArg: string | undefined): Promise<string> {
  const target = versionArg ?? "latest";
  if (target === "latest") return target;
  if (!isReleaseVersion(target)) {
    throw new Error(`invalid version: ${target}`);
  }
  const releases = await getReleases();
  if (!releases.entries.some((entry) => entry.tag === target)) {
    throw new Error(`version not in registry: ${target}`);
  }
  return target;
}

export async function runUpdate(
  cliEntrypoint: string,
  options: RunUpdateOptions,
  deps: UpdateDeps = createRealUpdateDeps(cliEntrypoint),
): Promise<void> {
  assertNotSourceCheckout();
  const force = options.force === true;
  const target = await resolveTargetVersion(options.version);

  const state = deps.readState();
  if (state.inProgress) {
    const live = isMonitorLive(state.inProgress.monitor, {
      pidAlive: deps.pidAlive,
      unitActive: deps.unitActive,
    });
    if (live && !force) {
      throw new Error("an update monitor is already running; pass --force to supersede it");
    }
    if (live && state.inProgress.monitor) {
      deps.stopMonitor(state.inProgress.monitor);
    }
  }

  const targets = makeTargets({ daemon: deps.readDaemonPort(), web: deps.readWebPort() });
  const [daemonH, webH] = await Promise.all([deps.probe(targets.daemon), deps.probe(targets.web)]);
  const preflight: Record<ServiceId, ProbeResult> = {
    daemon: daemonH,
    web: webH,
  };
  const allHealthy = SERVICE_IDS.every((id) => preflight[id].ok);
  if (!allHealthy && !force) {
    const failing = SERVICE_IDS.filter((id) => !preflight[id].ok).join(", ");
    throw new Error(`preflight health check failed for: ${failing}; pass --force to override`);
  }

  const startedAt = new Date(deps.now()).toISOString();
  // Only a fully healthy preflight may (re)record the rollback anchor; a forced
  // update on an unhealthy host keeps the previous known-good version.
  const lastKnownGood = allHealthy
    ? { version: deps.currentVersion, healthyAt: startedAt }
    : state.lastKnownGood;
  const inProgress: UpdateInProgress = {
    fromVersion: deps.currentVersion,
    toVersion: target,
    monitor: null,
    startedAt,
    phase: "installing",
  };
  deps.writeState({ version: 1, lastKnownGood, inProgress });

  deps.installVersion(target);
  deps.reinit();

  const monitor = deps.launch();
  deps.writeState({
    version: 1,
    lastKnownGood,
    inProgress: { ...inProgress, monitor, phase: "monitoring" },
  });

  deps.log(
    `Update to ${target} installed; monitoring health for rollback. Inspect: ` +
      "journalctl --user -u spur-update-monitor -f  or  ~/.spur/logs/update-monitor.log",
  );
}

async function runRollback(deps: UpdateDeps, reason: string, cfg: DecisionConfig): Promise<void> {
  const state = deps.readState();
  const good = state.lastKnownGood;
  deps.log(`Rolling back: ${reason}`);
  if (state.inProgress) {
    deps.writeState({ ...state, inProgress: { ...state.inProgress, phase: "rolling-back" } });
  }
  if (!good) {
    deps.log("No known-good version recorded; clearing update state without reinstalling.");
    deps.writeState({ ...deps.readState(), inProgress: null });
    return;
  }
  if (good.version === deps.readInstalledVersion()) {
    deps.log(`Installed version already matches known-good ${good.version}; nothing to reinstall.`);
    deps.writeState({ ...deps.readState(), inProgress: null });
    return;
  }
  deps.installVersion(good.version);
  deps.reinit();
  await verifyRollback(deps, cfg);
  deps.writeState({ ...deps.readState(), inProgress: null });
}

async function verifyRollback(deps: UpdateDeps, cfg: DecisionConfig): Promise<void> {
  const targets = makeTargets({ daemon: deps.readDaemonPort(), web: deps.readWebPort() });
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    await deps.sleep(
      cfg.pollMs > 0 ? Math.min(cfg.pollMs, VERIFY_INTERVAL_MS) : VERIFY_INTERVAL_MS,
    );
    const results = await Promise.all(SERVICE_IDS.map((id) => deps.probe(targets[id])));
    if (results.every((result) => result.ok)) {
      deps.log("Rollback verified healthy.");
      return;
    }
  }
  deps.log("Rollback completed but health probes did not fully recover; check services.");
}

export async function runUpdateMonitor(
  cliEntrypoint: string,
  deps: UpdateDeps = createRealUpdateDeps(cliEntrypoint),
  cfg: DecisionConfig = DEFAULT_DECISION_CONFIG,
): Promise<void> {
  const state = deps.readState();
  if (!state.inProgress || state.inProgress.phase !== "monitoring") {
    return;
  }

  let decisionState = initialDecisionState(deps.now());
  for (;;) {
    await deps.sleep(cfg.pollMs);
    const sample = await buildSample(deps, deps.now());
    const { decision, next } = evaluate(decisionState, sample, cfg);
    decisionState = next;

    if (decision.kind === "continue") {
      continue;
    }
    if (decision.kind === "commit") {
      deps.writeState({
        version: 1,
        lastKnownGood: {
          version: deps.readInstalledVersion(),
          healthyAt: new Date(deps.now()).toISOString(),
        },
        inProgress: null,
      });
      deps.log("Update stabilized; recorded new known-good version.");
      return;
    }
    if (decision.kind === "abandon") {
      deps.writeState({ ...deps.readState(), inProgress: null });
      deps.log("Update did not stabilize before the deadline; leaving it in place, no rollback.");
      return;
    }
    await runRollback(deps, decision.reason, cfg);
    return;
  }
}
