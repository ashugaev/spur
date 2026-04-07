#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { env, execPath, exit } from "node:process";

const { instanceConfigExists, resolveInstanceConfigPath } = await import("../dist/config.js");

if (!instanceConfigExists()) {
  exit(0);
}

const configPath = resolveInstanceConfigPath();

const result = spawnSync(execPath, ["dist/cli.js", "daemon", "restart", "--json"], {
  env: { ...env, SPUR_CONFIG: configPath },
  stdio: "ignore",
});

if (result.error) {
  throw result.error;
}

exit(result.status ?? 0);
