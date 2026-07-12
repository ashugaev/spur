import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dimText } from "./cli-view.js";

export interface HostInstallCheck {
  id: string;
  ok: boolean;
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
  if (home === homedir() && existsSync("/etc/systemd/system/spur-daemon.service")) {
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

export function collectHostInstallChecks(home = homedir()): HostInstallCheck[] {
  const checks: HostInstallCheck[] = [];
  const scope = resolveSystemdScope(home);
  const expectedPrefix = join(home, ".local");

  const npmPrefix = tryExec("npm", ["config", "get", "prefix"]);
  checks.push({
    id: "npm-prefix",
    ok: npmPrefix === expectedPrefix,
    detail: npmPrefix ? `npm prefix is ${npmPrefix}` : "npm prefix unavailable",
    fix: "npm config set prefix ~/.local",
  });

  const daemonUnit = join(scope.unitDir, "spur-daemon.service");
  const webUnit = join(scope.unitDir, "spur-web.service");
  const unitsInstalled = scope.kind !== "missing" && existsSync(daemonUnit) && existsSync(webUnit);
  checks.push({
    id: "systemd-units",
    ok: unitsInstalled,
    detail: unitsInstalled
      ? scope.kind === "system"
        ? "system systemd units installed"
        : "user systemd units installed"
      : "spur-daemon.service or spur-web.service missing",
    ...(scope.kind === "system" ? {} : { fix: "spur init" }),
  });

  if (scope.kind === "user") {
    const user = process.env["LOGNAME"] || process.env["USER"] || "";
    const linger = user ? tryExec("loginctl", ["show-user", user, "-p", "Linger"]) : undefined;
    const lingerOk = linger === "Linger=yes";
    checks.push({
      id: "linger",
      ok: lingerOk,
      detail: lingerOk ? "linger enabled" : "linger disabled or loginctl unavailable",
      fix: "loginctl enable-linger $USER",
    });
  } else if (scope.kind === "system") {
    checks.push({
      id: "linger",
      ok: true,
      detail: "system units (linger not required)",
    });
  } else {
    const user = process.env["LOGNAME"] || process.env["USER"] || "";
    const linger = user ? tryExec("loginctl", ["show-user", user, "-p", "Linger"]) : undefined;
    const lingerOk = linger === "Linger=yes";
    checks.push({
      id: "linger",
      ok: lingerOk,
      detail: lingerOk ? "linger enabled" : "linger disabled or loginctl unavailable",
      fix: "loginctl enable-linger $USER",
    });
  }

  const [ctlBin, ...ctlArgs] = scope.ctl;
  const systemdAvailable =
    ctlBin !== undefined && tryExec(ctlBin, ctlArgs.concat("status")) !== undefined;
  if (unitsInstalled && systemdAvailable) {
    const daemonActive = isActive(scope.ctl, "spur-daemon.service");
    checks.push({
      id: "spur-daemon",
      ok: daemonActive,
      detail: daemonActive ? "spur-daemon.service active" : "spur-daemon.service not active",
      fix: `${scope.restartCmd} spur-daemon.service`,
    });

    const webActive = isActive(scope.ctl, "spur-web.service");
    checks.push({
      id: "spur-web",
      ok: webActive,
      detail: webActive ? "spur-web.service active" : "spur-web.service not active",
      fix: `${scope.restartCmd} spur-web.service`,
    });

    const terminalUnit = join(scope.unitDir, "spur-direct-terminal.service");
    if (existsSync(terminalUnit)) {
      const terminalActive = isActive(scope.ctl, "spur-direct-terminal.service");
      checks.push({
        id: "spur-direct-terminal",
        ok: terminalActive,
        detail: terminalActive
          ? "spur-direct-terminal.service active"
          : "spur-direct-terminal.service not active (web terminal /ws will fail)",
        fix: `${scope.restartCmd} spur-direct-terminal.service`,
      });
    }
  }

  return checks;
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
  options: { noStart?: boolean; exposeWeb?: boolean; webPort?: string },
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
  execFileSync("bash", [script, ...args], { stdio: "inherit" });
}
