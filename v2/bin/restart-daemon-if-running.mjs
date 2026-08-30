#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { env, execPath, exit, stderr } from "node:process";

// Positive opt-in only: a build never restarts a daemon unless the caller
// explicitly asks. Restarting the daemon kills pipeline loops for all active
// sessions, and any caller outside a Spur session (a bare `pnpm build`, CI, a
// fast-test recipe) has no business touching one by default.
if (env.SPUR_BUILD_RESTART !== "1") {
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
// An explicit SPUR_BUILD_RESTART=1 still cannot hijack the host-global slot.
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
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

exit(result.status ?? 0);
