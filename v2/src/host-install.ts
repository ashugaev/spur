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

export function collectHostInstallChecks(home = homedir()): HostInstallCheck[] {
  const checks: HostInstallCheck[] = [];
  const unitDir = join(home, ".config", "systemd", "user");
  const expectedPrefix = join(home, ".local");

  const npmPrefix = tryExec("npm", ["config", "get", "prefix"]);
  checks.push({
    id: "npm-prefix",
    ok: npmPrefix === expectedPrefix,
    detail: npmPrefix ? `npm prefix is ${npmPrefix}` : "npm prefix unavailable",
    fix: "npm config set prefix ~/.local",
  });

  const daemonUnit = join(unitDir, "spur-daemon.service");
  const webUnit = join(unitDir, "spur-web.service");
  const unitsInstalled = existsSync(daemonUnit) && existsSync(webUnit);
  checks.push({
    id: "systemd-units",
    ok: unitsInstalled,
    detail: unitsInstalled
      ? "user systemd units installed"
      : "spur-daemon.service or spur-web.service missing",
    fix: "spur init",
  });

  const user = process.env["LOGNAME"] || process.env["USER"] || "";
  const linger = user ? tryExec("loginctl", ["show-user", user, "-p", "Linger"]) : undefined;
  const lingerOk = linger === "Linger=yes";
  checks.push({
    id: "linger",
    ok: lingerOk,
    detail: lingerOk ? "linger enabled" : "linger disabled or loginctl unavailable",
    fix: "loginctl enable-linger $USER",
  });

  const userSystemd = tryExec("systemctl", ["--user", "status"]) !== undefined;
  if (unitsInstalled && userSystemd) {
    const daemonActive =
      tryExec("systemctl", ["--user", "is-active", "spur-daemon.service"]) === "active";
    checks.push({
      id: "spur-daemon",
      ok: daemonActive,
      detail: daemonActive ? "spur-daemon.service active" : "spur-daemon.service not active",
      fix: "systemctl --user restart spur-daemon.service",
    });

    const webActive =
      tryExec("systemctl", ["--user", "is-active", "spur-web.service"]) === "active";
    checks.push({
      id: "spur-web",
      ok: webActive,
      detail: webActive ? "spur-web.service active" : "spur-web.service not active",
      fix: "systemctl --user restart spur-web.service",
    });
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
