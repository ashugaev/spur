#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { env, execPath, exit } from "node:process";

// Skip daemon restart when running inside a Spur session (worktree build).
// Restarting the daemon kills pipeline loops for all active sessions.
if (env.SPUR_SESSION) {
  exit(0);
}

// Skip when the deploy sets SPUR_DISABLE_AUTOSTART for the build. The deploy's
// systemd restart is the authoritative daemon restart; this in-build restart is
// redundant and was racing/aborting the deploy (it ran `daemon restart` and
// exited nonzero under prod cron, tripping `set -e` before the deploy's own
// restart+verify could run). A genuinely broken `tsc` still fails the build.
if (env.SPUR_DISABLE_AUTOSTART) {
  exit(0);
}

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
