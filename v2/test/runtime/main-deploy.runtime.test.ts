import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTempDir } from "../helpers/common.js";

const BASH = "/usr/bin/bash";
const DEFAULT_PATH_PREFIX = "/usr/bin:/bin";
const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/main-deploy.sh");
const DAEMON_TEMPLATE_PATH = resolve(REPO_ROOT, "deploy/spur-daemon.service");
const WEB_TEMPLATE_PATH = resolve(REPO_ROOT, "deploy/spur-web.service");

interface RuntimeBinExports {
  NODE_BIN: string;
  PNPM_BIN: string;
  SPUR_NVM_BIN_PREFIX: string;
}

async function writeExecutable(path: string, body = "#!/bin/sh\n"): Promise<void> {
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

async function runResolveRuntimeBins(options: {
  serviceHome: string;
  pathEntries: string[];
}): Promise<RuntimeBinExports> {
  const fakePath = options.pathEntries.join(":");
  const script = `
set -euo pipefail
PATH=${JSON.stringify(DEFAULT_PATH_PREFIX)}
# shellcheck source=/dev/null
source ${JSON.stringify(SCRIPT_PATH)}
PATH=${JSON.stringify(`${fakePath}:${DEFAULT_PATH_PREFIX}`)}
resolve_runtime_bins
printf 'NODE_BIN=%s\\n' "$NODE_BIN"
printf 'PNPM_BIN=%s\\n' "$PNPM_BIN"
printf 'SPUR_NVM_BIN_PREFIX=%s\\n' "$SPUR_NVM_BIN_PREFIX"
`;
  const { stdout } = await execFileAsync(BASH, ["-c", script], {
    env: {
      HOME: options.serviceHome,
      MAIN_DEPLOY_SERVICE_HOME: options.serviceHome,
      PATH: DEFAULT_PATH_PREFIX,
    },
  });
  const exports: Partial<RuntimeBinExports> = {};
  for (const line of stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "NODE_BIN" || key === "PNPM_BIN" || key === "SPUR_NVM_BIN_PREFIX") {
      exports[key] = value;
    }
  }
  return exports as RuntimeBinExports;
}

async function runResolveRuntimeBinsExpectFailure(options: {
  serviceHome: string;
  pathEntries: string[];
}): Promise<{ code: number | null; stderr: string }> {
  const fakePath = options.pathEntries.join(":");
  const script = `
set -euo pipefail
PATH=${JSON.stringify(DEFAULT_PATH_PREFIX)}
# shellcheck source=/dev/null
source ${JSON.stringify(SCRIPT_PATH)}
PATH=${JSON.stringify(fakePath)}
resolve_runtime_bins
`;
  try {
    await execFileAsync(BASH, ["-c", script], {
      env: {
        HOME: options.serviceHome,
        MAIN_DEPLOY_SERVICE_HOME: options.serviceHome,
        PATH: DEFAULT_PATH_PREFIX,
      },
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      code?: number | string;
      stderr?: string;
      stdout?: string;
    };
    const message = `${execError.stderr ?? ""}${execError.stdout ?? ""}${execError.message ?? error}`;
    return {
      code: typeof execError.code === "number" ? execError.code : 1,
      stderr: message,
    };
  }
}

async function renderServicePath(templatePath: string, prefix: string): Promise<string> {
  const template = await readFile(templatePath, "utf8");
  const line = template
    .split("\n")
    .find((entry) => entry.startsWith("Environment=PATH="));
  if (!line) {
    throw new Error(`PATH line not found in ${templatePath}`);
  }
  const rendered = line
    .replaceAll("{{SPUR_NVM_BIN_PREFIX}}", prefix)
    .replaceAll("{{SPUR_SERVICE_HOME}}", "/home/service");
  return rendered.slice("Environment=PATH=".length);
}

describe("main-deploy runtime bin resolution", () => {
  it("resolves nvm node/pnpm and derives the nvm PATH prefix", async () => {
    const serviceHome = await createTempDir("main-deploy-nvm-");
    const nvmBinDir = resolve(serviceHome, ".nvm/versions/node/v20.19.0/bin");
    await mkdir(nvmBinDir, { recursive: true });
    const nodePath = resolve(nvmBinDir, "node");
    const pnpmPath = resolve(nvmBinDir, "pnpm");
    await writeExecutable(nodePath);
    await writeExecutable(pnpmPath);

    const exports = await runResolveRuntimeBins({
      serviceHome,
      pathEntries: [nvmBinDir],
    });

    expect(exports.NODE_BIN).toBe(nodePath);
    expect(exports.PNPM_BIN).toBe(pnpmPath);
    expect(exports.SPUR_NVM_BIN_PREFIX).toBe(`${nvmBinDir}:`);
  });

  it("leaves SPUR_NVM_BIN_PREFIX empty for non-nvm node", async () => {
    const serviceHome = await createTempDir("main-deploy-apt-");
    const binDir = resolve(serviceHome, "bin");
    await mkdir(binDir, { recursive: true });
    const nodePath = resolve(binDir, "node");
    const pnpmPath = resolve(binDir, "pnpm");
    await writeExecutable(nodePath);
    await writeExecutable(pnpmPath);

    const exports = await runResolveRuntimeBins({
      serviceHome,
      pathEntries: [binDir],
    });

    expect(exports.NODE_BIN).toBe(nodePath);
    expect(exports.PNPM_BIN).toBe(pnpmPath);
    expect(exports.SPUR_NVM_BIN_PREFIX).toBe("");
  });

  it("aborts when node is missing", async () => {
    const serviceHome = await createTempDir("main-deploy-no-node-");
    const binDir = resolve(serviceHome, "bin");
    await mkdir(binDir, { recursive: true });
    await writeExecutable(resolve(binDir, "pnpm"));

    const result = await runResolveRuntimeBinsExpectFailure({
      serviceHome,
      pathEntries: [binDir],
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node not found");
  });

  it("aborts when pnpm is missing", async () => {
    const serviceHome = await createTempDir("main-deploy-no-pnpm-");
    const binDir = resolve(serviceHome, "bin");
    await mkdir(binDir, { recursive: true });
    await writeExecutable(resolve(binDir, "node"));

    const result = await runResolveRuntimeBinsExpectFailure({
      serviceHome,
      pathEntries: [binDir],
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pnpm not found");
  });

  it("renders daemon and web PATH without :: or a leading colon", async () => {
    const serviceHome = await createTempDir("main-deploy-path-");
    const nvmBinDir = resolve(serviceHome, ".nvm/versions/node/v20.19.0/bin");
    await mkdir(nvmBinDir, { recursive: true });
    await writeExecutable(resolve(nvmBinDir, "node"));
    await writeExecutable(resolve(nvmBinDir, "pnpm"));

    const exports = await runResolveRuntimeBins({
      serviceHome,
      pathEntries: [nvmBinDir],
    });
    const nvmDaemonPath = await renderServicePath(
      DAEMON_TEMPLATE_PATH,
      exports.SPUR_NVM_BIN_PREFIX,
    );
    const nvmWebPath = await renderServicePath(WEB_TEMPLATE_PATH, exports.SPUR_NVM_BIN_PREFIX);
    expect(nvmDaemonPath).not.toMatch(/^:/);
    expect(nvmDaemonPath).not.toContain("::");
    expect(nvmWebPath).not.toMatch(/^:/);
    expect(nvmWebPath).not.toContain("::");

    const emptyDaemonPath = await renderServicePath(DAEMON_TEMPLATE_PATH, "");
    const emptyWebPath = await renderServicePath(WEB_TEMPLATE_PATH, "");
    expect(emptyDaemonPath).not.toMatch(/^:/);
    expect(emptyDaemonPath).not.toContain("::");
    expect(emptyWebPath).not.toMatch(/^:/);
    expect(emptyWebPath).not.toContain("::");
  });

  it("does not run deploy side effects when sourced", async () => {
    const script = `
set -euo pipefail
# shellcheck source=/dev/null
source ${JSON.stringify(SCRIPT_PATH)}
type resolve_runtime_bins >/dev/null
type install_service_files >/dev/null
printf 'sourced-ok\\n'
`;
    const { stdout } = await execFileAsync(BASH, ["-c", script], {
      env: {
        HOME: "/tmp",
        PATH: process.env["PATH"] ?? DEFAULT_PATH_PREFIX,
      },
    });
    expect(stdout.trim()).toBe("sourced-ok");
  });
});
