#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cwd, chdir, env, execPath, exit } from "node:process";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageDir, "dist/cli.js");
const { resolveConfigPath } = await import("../dist/config.js");

function tryResolveConfigPath(baseDir) {
  const previous = cwd();
  chdir(baseDir);
  try {
    return resolveConfigPath();
  } catch {
    return undefined;
  } finally {
    chdir(previous);
  }
}

const configPath = tryResolveConfigPath(cwd()) ?? tryResolveConfigPath(packageDir);
if (!configPath) {
  exit(0);
}

const result = spawnSync(execPath, [cliPath, "daemon", "restart", "--json"], {
  cwd: packageDir,
  env: { ...env, SPUR_CONFIG: configPath },
  stdio: "ignore",
});

if (result.error) {
  throw result.error;
}

exit(result.status ?? 0);
