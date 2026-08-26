#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { env, execPath, exit, stderr } from "node:process";

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

const { instanceConfigExists, isDefaultInstanceConfigPath, resolveInstanceConfigPath } =
  await import("../dist/config.js");

if (!instanceConfigExists()) {
  exit(0);
}

const configPath = resolveInstanceConfigPath();

// The default instance config path is the host-global production slot: the
// daemon that owns it is whatever the host installed (npm package or source
// deploy), NOT this tree. Restarting it from here kills the installed daemon
// and relaunches production out of this checkout's dist/cli.js, detached from
// systemd — observed on a prod host where the systemd unit then sat at
// EADDRINUSE for 13h while a worktree build served :4310.
//
// No caller needs this: an in-session build is already skipped above, and the
// source deploy sets SPUR_DISABLE_AUTOSTART and does its own systemd restart.
// A maintainer wanting their host daemon reloaded runs `spur daemon restart`.
if (isDefaultInstanceConfigPath(configPath)) {
  stderr.write(
    `restart-daemon-if-running: skipping — ${configPath} is the host default instance config, ` +
      `whose daemon this tree does not own. Run 'spur daemon restart' to reload the host daemon.\n`,
  );
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
