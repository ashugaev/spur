import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { dimText } from "./cli-view.js";
import { findListenerPids, isHostPortFree } from "./port-probe.js";
import {
  makeTargets,
  probe,
  probeInfo,
  readWebPort,
  resolveDaemonPortReadOnly,
  type ProbeTarget,
  type ServiceId,
} from "./update-health.js";
import { version } from "./version.js";

export interface HostInstallCheck {
  id: string;
  ok: boolean;
  severity: "error" | "warn" | "info";
  detail: string;
  fix?: string;
}

export interface SystemdScope {
  kind: "user" | "system" | "missing";
  unitDir: string;
  ctl: string[];
  restartCmd: string;
}

function tryExec(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function isActive(ctl: string[], unit: string): boolean {
  const [bin, ...args] = ctl;
  if (!bin) return false;
  return tryExec(bin, [...args, "is-active", unit]) === "active";
}

export function resolveSystemdScope(home: string): SystemdScope {
  const userUnitDir = join(home, ".config", "systemd", "user");
  if (existsSync(join(userUnitDir, "spur-daemon.service"))) {
    return {
      kind: "user",
      unitDir: userUnitDir,
      ctl: ["systemctl", "--user"],
      restartCmd: "systemctl --user restart",
    };
  }
  // Compare against the unfakeable account home (`userInfo().homedir`, which
  // ignores `$HOME`) rather than `homedir()` (which honors `$HOME`). System
  // units are host-global, not namespaced per `$HOME`, so a caller running
  // under a test's overridden `$HOME` — where `home` defaults to `homedir()`
  // and would otherwise trivially equal itself — must not spuriously pick up
  // a real system-wide install that belongs to a different invocation.
  if (home === userInfo().homedir && existsSync("/etc/systemd/system/spur-daemon.service")) {
    return {
      kind: "system",
      unitDir: "/etc/systemd/system",
      ctl: ["systemctl"],
      restartCmd: "sudo systemctl restart",
    };
  }
  return {
    kind: "missing",
    unitDir: userUnitDir,
    ctl: ["systemctl", "--user"],
    restartCmd: "systemctl --user restart",
  };
}

// F3: a real actionable PATH gap requires that this host actually npm-installed
// spur under `npmPrefix` — otherwise every dev checkout / alternate package
// manager host would false-flag as broken.
export function checkSpurOnPath(npmPrefix: string | undefined): HostInstallCheck {
  if (!npmPrefix) {
    return {
      id: "npm-bin-on-path",
      ok: true,
      severity: "info",
      detail: "skipped — npm prefix unavailable",
    };
  }
  const binDir = join(npmPrefix, "bin");
  if (!existsSync(join(binDir, "spur"))) {
    return {
      id: "npm-bin-on-path",
      ok: true,
      severity: "info",
      detail: `skipped — no npm-installed spur binary detected at ${binDir}`,
    };
  }
  const onPath = (process.env["PATH"] ?? "").split(delimiter).includes(binDir);
  return {
    id: "npm-bin-on-path",
    ok: onPath,
    severity: onPath ? "info" : "error",
    detail: onPath ? `${binDir} is on PATH` : `${binDir} is not on PATH`,
    ...(onPath ? {} : { fix: `add ${binDir} to PATH` }),
  };
}

// F4: presence-only checks for the two external binaries every spawn depends on.
function checkTmuxInstalled(): HostInstallCheck {
  const detail = tryExec("tmux", ["-V"]);
  return {
    id: "tmux-installed",
    ok: detail !== undefined,
    severity: "error",
    detail: detail ?? "tmux not found on PATH",
    ...(detail === undefined ? { fix: "install tmux" } : {}),
  };
}

function checkGitInstalled(): HostInstallCheck {
  const detail = tryExec("git", ["--version"]);
  return {
    id: "git-installed",
    ok: detail !== undefined,
    severity: "error",
    detail: detail ?? "git not found on PATH",
    ...(detail === undefined ? { fix: "install git" } : {}),
  };
}

interface EnginesField {
  node?: string;
}

function readEnginesNodeRange(): string | undefined {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgUrl, "utf8")) as { engines?: EnginesField };
    return typeof parsed.engines?.node === "string" ? parsed.engines.node : undefined;
  } catch {
    return undefined;
  }
}

function parseVersionTuple(value: string): [number, number, number] {
  const parts = value.replace(/^v/, "").split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10);
  const minor = Number.parseInt(parts[1] ?? "0", 10);
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  return [
    Number.isNaN(major) ? 0 : major,
    Number.isNaN(minor) ? 0 : minor,
    Number.isNaN(patch) ? 0 : patch,
  ];
}

function compareTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Scoped to the two range operators actually present in `engines.node` today
// (`^X.Y.Z` and `>=X`) — not a general semver-range parser.
function satisfiesClause(clause: string, current: [number, number, number]): boolean {
  const trimmed = clause.trim();
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (caret) {
    const major = Number.parseInt(caret[1] ?? "0", 10);
    const min: [number, number, number] = [
      major,
      Number.parseInt(caret[2] ?? "0", 10),
      Number.parseInt(caret[3] ?? "0", 10),
    ];
    const max: [number, number, number] = [major + 1, 0, 0];
    return compareTuples(current, min) >= 0 && compareTuples(current, max) < 0;
  }
  const gte = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (gte) {
    const min: [number, number, number] = [
      Number.parseInt(gte[1] ?? "0", 10),
      Number.parseInt(gte[2] ?? "0", 10),
      Number.parseInt(gte[3] ?? "0", 10),
    ];
    return compareTuples(current, min) >= 0;
  }
  return false;
}

export function satisfiesNodeEngineRange(range: string, currentVersion: string): boolean {
  const current = parseVersionTuple(currentVersion);
  return range.split("||").some((clause) => satisfiesClause(clause, current));
}

function checkNodeVersion(): HostInstallCheck {
  const range = readEnginesNodeRange();
  if (!range) {
    return {
      id: "node-version",
      ok: true,
      severity: "info",
      detail: "skipped — could not read engines.node from package.json",
    };
  }
  const satisfied = satisfiesNodeEngineRange(range, process.version);
  return {
    id: "node-version",
    ok: satisfied,
    severity: satisfied ? "info" : "error",
    detail: satisfied
      ? `node ${process.version} satisfies ${range}`
      : `node ${process.version} does not satisfy required range ${range}`,
    ...(satisfied ? {} : { fix: `install a Node version matching ${range}` }),
  };
}

export interface ServiceHealthResult {
  checks: HostInstallCheck[];
  daemonReachable: boolean;
  daemonPort: number;
}

// F6: distinguishes "not started yet" (warn) from "systemd says active but HTTP
// is dead" or "something else is squatting the port" (error). Reuses the
// already-computed `daemonActive`/`webActive` booleans instead of re-querying
// systemd a second time. Exported so fast tests can drive daemon/web
// active-vs-inactive scenarios directly, without simulating systemctl.
export async function checkServiceHealth(
  scope: SystemdScope,
  daemonActive: boolean,
  webActive: boolean,
): Promise<ServiceHealthResult> {
  const daemonPort = resolveDaemonPortReadOnly();
  const webPort = readWebPort(scope);
  const targets = makeTargets({ daemon: daemonPort, web: webPort });

  const services: Array<{
    id: ServiceId;
    unit: string;
    active: boolean;
    port: number;
    target: ProbeTarget;
  }> = [
    {
      id: "daemon",
      unit: "spur-daemon.service",
      active: daemonActive,
      port: daemonPort,
      target: targets.daemon,
    },
    { id: "web", unit: "spur-web.service", active: webActive, port: webPort, target: targets.web },
  ];

  const checks: HostInstallCheck[] = [];
  let daemonReachable = false;

  for (const service of services) {
    const result = await probe(service.target);
    if (result.ok) {
      if (service.id === "daemon") daemonReachable = true;
      checks.push({
        id: `${service.id}-reachable`,
        ok: true,
        severity: "info",
        detail: `${service.unit} responded at ${service.target.url}`,
      });
      continue;
    }
    if (service.active) {
      checks.push({
        id: `${service.id}-reachable`,
        ok: false,
        severity: "error",
        detail: `${service.unit} is active but unreachable at ${service.target.url} (${result.reason})`,
        fix: `${scope.restartCmd} ${service.unit}`,
      });
      continue;
    }
    const portFree = await isHostPortFree(service.port);
    if (!portFree) {
      const pids = await findListenerPids(service.port);
      checks.push({
        id: `${service.id}-port-conflict`,
        ok: false,
        severity: "error",
        detail: `port ${service.port} expected for ${service.unit} is held by another process (pid ${pids.join(", ") || "unknown"})`,
      });
      continue;
    }
    checks.push({
      id: `${service.id}-reachable`,
      ok: false,
      severity: "warn",
      detail: `${service.unit} is not running (port ${service.port} is free)`,
    });
  }

  return { checks, daemonReachable, daemonPort };
}

// F8: only probed once F6 already confirmed the daemon answers HTTP, so a
// down/unreachable daemon never produces a spurious drift check. Exported for
// direct testing alongside `checkServiceHealth`.
export async function checkVersionDrift(
  daemonReachable: boolean,
  daemonPort: number,
): Promise<HostInstallCheck | undefined> {
  if (!daemonReachable) return undefined;
  const info = await probeInfo({ id: "daemon", url: `http://127.0.0.1:${daemonPort}/info` });
  if (!info) return undefined;
  const drifted = info.version !== version;
  return {
    id: "version-drift",
    ok: !drifted,
    severity: drifted ? "warn" : "info",
    detail: drifted
      ? `daemon reports version ${info.version}, installed package is ${version}`
      : `daemon version ${info.version} matches the installed package`,
    ...(drifted ? { fix: "spur update" } : {}),
  };
}

export async function collectHostInstallChecks(home = homedir()): Promise<HostInstallCheck[]> {
  const checks: HostInstallCheck[] = [];
  const scope = resolveSystemdScope(home);
  const expectedPrefix = join(home, ".local");

  const npmPrefix = tryExec("npm", ["config", "get", "prefix"]);
  checks.push({
    id: "npm-prefix",
    ok: npmPrefix === expectedPrefix,
    severity: "warn",
    detail: npmPrefix ? `npm prefix is ${npmPrefix}` : "npm prefix unavailable",
    fix: "npm config set prefix ~/.local",
  });

  let daemonActive = false;
  let webActive = false;

  if (scope.kind === "missing" && platform() !== "linux") {
    checks.push({
      id: "systemd-not-applicable",
      ok: true,
      severity: "info",
      detail: "systemd user units are Linux-only; verify install manually on this platform",
    });
  } else {
    const daemonUnit = join(scope.unitDir, "spur-daemon.service");
    const webUnit = join(scope.unitDir, "spur-web.service");
    const unitsInstalled =
      scope.kind !== "missing" && existsSync(daemonUnit) && existsSync(webUnit);
    checks.push({
      id: "systemd-units",
      ok: unitsInstalled,
      severity: "warn",
      detail: unitsInstalled
        ? scope.kind === "system"
          ? "system systemd units installed"
          : "user systemd units installed"
        : "spur-daemon.service or spur-web.service missing",
      ...(scope.kind === "system" ? {} : { fix: "spur init" }),
    });

    if (scope.kind === "system") {
      checks.push({
        id: "linger",
        ok: true,
        severity: "warn",
        detail: "system units (linger not required)",
      });
    } else {
      const user = process.env["LOGNAME"] || process.env["USER"] || "";
      const linger = user ? tryExec("loginctl", ["show-user", user, "-p", "Linger"]) : undefined;
      const lingerOk = linger === "Linger=yes";
      checks.push({
        id: "linger",
        ok: lingerOk,
        severity: "warn",
        detail: lingerOk ? "linger enabled" : "linger disabled or loginctl unavailable",
        fix: "loginctl enable-linger $USER",
      });
    }

    const [ctlBin, ...ctlArgs] = scope.ctl;
    const systemdAvailable =
      ctlBin !== undefined && tryExec(ctlBin, ctlArgs.concat("status")) !== undefined;
    if (unitsInstalled && systemdAvailable) {
      daemonActive = isActive(scope.ctl, "spur-daemon.service");
      checks.push({
        id: "spur-daemon",
        ok: daemonActive,
        severity: "error",
        detail: daemonActive ? "spur-daemon.service active" : "spur-daemon.service not active",
        fix: `${scope.restartCmd} spur-daemon.service`,
      });

      webActive = isActive(scope.ctl, "spur-web.service");
      checks.push({
        id: "spur-web",
        ok: webActive,
        severity: "error",
        detail: webActive ? "spur-web.service active" : "spur-web.service not active",
        fix: `${scope.restartCmd} spur-web.service`,
      });
    }
  }

  checks.push(checkSpurOnPath(npmPrefix));
  checks.push(checkTmuxInstalled());
  checks.push(checkGitInstalled());
  checks.push(checkNodeVersion());

  const health = await checkServiceHealth(scope, daemonActive, webActive);
  checks.push(...health.checks);
  const drift = await checkVersionDrift(health.daemonReachable, health.daemonPort);
  if (drift) checks.push(drift);

  return checks;
}

export function hasErrorSeverity(checks: HostInstallCheck[]): boolean {
  return checks.some((check) => !check.ok && check.severity === "error");
}

export function renderHostInstallChecks(checks: HostInstallCheck[]): string {
  const lines = checks.map((check) => {
    const mark = check.ok ? "ok" : "missing";
    const fix = check.ok || !check.fix ? "" : ` — fix: ${check.fix}`;
    return dimText(`[${mark}] ${check.detail}${fix}`);
  });
  return lines.join("\n");
}

export function resolveNpmInitScript(cliEntrypoint: string): string {
  const cliPath = realpathSync(cliEntrypoint);
  return join(dirname(cliPath), "..", "scripts", "npm-init.sh");
}

export function runNpmInit(
  cliEntrypoint: string,
  options: { noStart?: boolean; exposeWeb?: boolean; webPort?: string; tailscale?: boolean },
): void {
  const script = resolveNpmInitScript(cliEntrypoint);
  if (!existsSync(script)) {
    throw new Error(`npm init script not found: ${script}`);
  }
  const args: string[] = [];
  if (options.noStart) {
    args.push("--no-start");
  }
  if (options.exposeWeb) {
    args.push("--expose-web");
  }
  if (options.webPort) {
    args.push("--web-port", options.webPort);
  }
  args.push(options.tailscale === false ? "--no-tailscale" : "--tailscale");
  execFileSync("bash", [script, ...args], { stdio: "inherit" });
}
