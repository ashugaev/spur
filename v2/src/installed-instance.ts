import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, parseDocument } from "yaml";
import {
  ensureInstanceConfig,
  isDefaultInstanceConfigPath,
  loadInstanceConnectionConfigReadOnly,
  type InstanceConnectionConfig,
} from "./config.js";
import { defaultMcpPort } from "./ports.js";

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !isAbsolute(value) ||
    hasControlCharacters(value)
  ) {
    throw new Error(
      "Installed instance config path must be an absolute path without control characters",
    );
  }
  return value;
}

export function installedInstanceReceiptPath(home = homedir()): string {
  return join(home, ".spur", "installed-instance.json");
}

export function readInstalledInstancePath(home = homedir()): string | undefined {
  const path = installedInstanceReceiptPath(home);
  if (!existsSync(path)) return undefined;
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error("Installed instance receipt must be private (0600)");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Installed instance receipt is invalid; rerun init with --config");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !("configPath" in value)
  ) {
    throw new Error("Installed instance receipt is invalid; rerun init with --config");
  }
  return validatePath(value.configPath);
}

export function writeInstalledInstance(configPath: string, home = homedir()): void {
  const path = installedInstanceReceiptPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ configPath: validatePath(configPath) }), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface InstallationSelection {
  home: string;
  workingDirectory: string;
  scope: "user" | "system";
  daemonEnvFile: string;
  daemonUnitPath: string;
  configModulePath: string;
  configPath?: string;
  serviceUser?: string;
}

function probeStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const { stderr } = error;
  return (typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "")
    .trim()
    .slice(-500);
}

function rejectsExpandEnvironment(error: unknown): boolean {
  return /(?:unrecognized|unknown) option\b[^\n]*--expand-environment/i.test(probeStderr(error));
}

export function resolveInstallationConfig(options: InstallationSelection): string {
  let selected = options.configPath?.trim() || process.env["SPUR_CONFIG"]?.trim();
  let allowMissingDefault = false;
  if (selected) selected = resolve(selected);
  else {
    selected = readInstalledInstancePath(options.home);
    if (!selected) {
      if (
        existsSync(options.daemonUnitPath) &&
        /^ExecStart=.*(?:^|\s)--config(?:\s|=)/m.test(readFileSync(options.daemonUnitPath, "utf8"))
      ) {
        throw new Error(
          "Installed daemon has --config without its receipt; rerun init/reinit with --config <existing-path>",
        );
      }
      if (existsSync(options.daemonEnvFile) || options.scope === "system") {
        const code = `import {resolveInstanceConfigPath} from ${JSON.stringify(pathToFileURL(options.configModulePath).href)}; process.stdout.write(JSON.stringify(resolveInstanceConfigPath()));`;
        const properties = [
          `WorkingDirectory=${options.workingDirectory}`,
          `Environment=HOME=${options.home}`,
          `EnvironmentFile=${options.scope === "user" ? "-" : ""}${options.daemonEnvFile}`,
        ];
        if (options.serviceUser) properties.push(`User=${options.serviceUser}`);
        const args = [
          "--wait",
          "--pipe",
          "--quiet",
          "--collect",
          "--service-type=exec",
          ...(options.scope === "user" ? ["--user"] : []),
          ...properties.flatMap((property) => ["--property", property]),
          "/usr/bin/node",
          "--input-type=module",
          "-e",
          code,
        ];
        const runProbe = (probeArgs: string[]): string =>
          execFileSync(
            options.scope === "system" ? "sudo" : "systemd-run",
            options.scope === "system" ? ["systemd-run", ...probeArgs] : probeArgs,
            {
              encoding: "utf8",
              timeout: 10_000,
              maxBuffer: 16_384,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
        let output: string;
        try {
          try {
            output = runProbe(["--expand-environment=no", ...args]);
          } catch (error) {
            // systemd < 254 rejects the flag and never expands $VAR in command args.
            if (!rejectsExpandEnvironment(error)) throw error;
            output = runProbe(args);
          }
        } catch (error) {
          const stderr = probeStderr(error);
          throw new Error(
            `Cannot resolve daemon environment through systemd; existing installation was preserved${stderr ? `: ${stderr}` : ""}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(output);
        } catch {
          throw new Error("Daemon config probe returned invalid output");
        }
        selected = validatePath(parsed);
      } else selected = join(options.home, ".spur", "config.yaml");
      allowMissingDefault = true;
    }
  }
  selected = validatePath(selected);
  const loaded = loadInstanceConnectionConfigReadOnly(selected);
  if (loaded.status === "absent" && allowMissingDefault && isDefaultInstanceConfigPath(selected))
    return selected;
  if (loaded.status === "invalid")
    throw new Error(`Selected installed instance configuration: ${loaded.error}`);
  if (loaded.status === "absent")
    throw new Error("Selected installed instance configuration is missing");
  return realpathSync(loaded.config.configPath);
}

export function prepareInstallationConfig(
  configPath: string,
  actualWebPort: number,
): InstanceConnectionConfig {
  let loaded = loadInstanceConnectionConfigReadOnly(configPath);
  if (loaded.status === "absent" && isDefaultInstanceConfigPath(configPath)) {
    ensureInstanceConfig(configPath);
    loaded = loadInstanceConnectionConfigReadOnly(configPath);
  }
  if (loaded.status === "invalid")
    throw new Error(`Selected installed instance configuration: ${loaded.error}`);
  if (loaded.status === "absent")
    throw new Error("Selected installed instance configuration is missing");
  if (loaded.config.mcp.port !== actualWebPort) return loaded.config;
  const target = realpathSync(configPath);
  const document = parseDocument(readFileSync(target, "utf8"));
  if (!isMap(document.contents) || document.hasIn(["mcp", "port"])) {
    throw new Error("mcp.port must differ from the installed web listen port");
  }
  document.setIn(
    ["mcp", "port"],
    defaultMcpPort(loaded.config.server.port, loaded.config.ui.port, actualWebPort),
  );
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, document.toString(), { mode: statSync(target).mode & 0o777 });
    const candidate = loadInstanceConnectionConfigReadOnly(temporary);
    if (candidate.status !== "ok")
      throw new Error(
        `Generated MCP port migration: ${candidate.status === "invalid" ? candidate.error : "configuration is missing"}`,
      );
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  const migrated = loadInstanceConnectionConfigReadOnly(configPath);
  if (migrated.status !== "ok")
    throw new Error(
      `Migrated MCP port configuration: ${migrated.status === "invalid" ? migrated.error : "configuration is missing"}`,
    );
  return migrated.config;
}

export function quoteSystemdArgument(value: string): string {
  if (hasControlCharacters(value)) throw new Error("Systemd argument contains control characters");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;
}

export function renderPinnedUnit(contents: string, configPath: string, web = false): string {
  const path = quoteSystemdArgument(validatePath(configPath));
  if (web)
    return contents.replace(
      /^ExecStart=(.+)$/m,
      (_, command: string) =>
        `ExecStart=/usr/bin/env ${quoteSystemdArgument(`SPUR_CONFIG=${configPath}`)} ${command}`,
    );
  const rendered = contents.replace(
    /^(ExecStart=.+?\/cli\.js)( .+)$/m,
    (_, command: string, args: string) => `${command} --config ${path}${args}`,
  );
  if (rendered === contents) throw new Error("Cannot pin configuration in service command");
  return rendered;
}
