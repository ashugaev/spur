#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cwd, chdir, env, execPath, exit } from "node:process";

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

const configPath = tryResolveConfigPath(cwd()) ?? tryResolveConfigPath("..");
if (!configPath) {
  exit(0);
}

const result = spawnSync(execPath, ["dist/cli.js", "daemon", "restart", "--json"], {
  env: { ...env, SPUR_CONFIG: configPath },
  stdio: "ignore",
});

if (result.error) {
  throw result.error;
}

exit(result.status ?? 0);
