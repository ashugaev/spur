import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionView } from "../../src/types.js";
import { createTempDir, findFreePort, pollUntil } from "../helpers/common.js";
import {
  createRuntimeTestContext,
  execTmux,
  isTmuxAvailable,
  killTmuxSessionsByPrefix,
  stopDaemonByPid,
  syncTmuxEnvironment,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

// Issue #1002. Every tmux new-session argv carried the daemon's whole env and
// the per-call agent env, readable by any local user. These cases drive a REAL
// daemon against a REAL tmux server: a `tmux` shim first on the daemon's PATH
// logs each full argv (NUL-joined) before exec'ing the real tmux, and a
// sentinel in the daemon's env must reach both panes without ever touching
// that log.
const REAL_TMUX = "/usr/bin/tmux";
const PANE_ENV_FILE_PREFIX = ".spur-pane-env.";

function tmuxShim(argvLog: string): string {
  return `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "${argvLog}"
exec ${REAL_TMUX} "$@"
`;
}

// Records its own env value and pid in the worktree, then execs (exec keeps
// the pid) so the afterAll sweep can kill it.
const DEV_SIDECAR = `#!/usr/bin/env bash
printenv SPUR_TEST_ARGV_SENTINEL > ".sentinel-dev-\${SPUR_SESSION:?}"
echo "$$" > ".pid-dev-\${SPUR_SESSION:?}"
exec sleep 3600
`;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!tmuxOk)("tmux argv carries no env values (runtime, #1002)", () => {
  let context: RuntimeTestContext;
  let configPath: string;
  let daemonPid: number | undefined;
  let argvLog: string;
  let daemonTmpDir: string;
  let sessionPrefix: string;
  const sentinel = `argv-sentinel-${randomUUID()}`;
  const sidecarPids = new Set<number>();

  const readPaneEnviron = async (sessionName: string): Promise<Buffer | null> => {
    try {
      const pid = Number.parseInt(
        (await execTmux(["display-message", "-p", "-t", `=${sessionName}:`, "#{pane_pid}"])).stdout,
        10,
      );
      return Number.isInteger(pid) ? await readFile(`/proc/${pid}/environ`) : null;
    } catch {
      return null;
    }
  };

  const paneEnvFiles = async (dir: string): Promise<string[]> =>
    (await readdir(dir)).filter((name) => name.startsWith(PANE_ENV_FILE_PREFIX));

  beforeAll(async () => {
    const port = await findFreePort();
    context = await createRuntimeTestContext(port);
    sessionPrefix = `rt-argv-${port}`;
    const rootDir = join(context.fakeBinDir, "..");
    argvLog = join(rootDir, "argv.log");
    await writeFile(argvLog, "", "utf8");
    // A dedicated TMPDIR for the daemon: the command pane's env file lands in
    // its resolveTempDir(), so a sweep of it sees only this run's files.
    daemonTmpDir = await createTempDir("spur-argv-tmp-");
    context.env["SPUR_TEST_ARGV_SENTINEL"] = sentinel;
    context.env["SPUR_TMUX_SYSTEMD_SCOPE"] = "direct";
    context.env["TMPDIR"] = daemonTmpDir;
    // Shadows the real tmux for the DAEMON only: fakeBinDir is first on the
    // daemon's PATH, never on this vitest process's.
    const shimPath = join(context.fakeBinDir, "tmux");
    await writeFile(shimPath, tmuxShim(argvLog), "utf8");
    await chmod(shimPath, 0o755);

    const devPath = join(rootDir, "dev-sidecar.sh");
    await writeFile(devPath, DEV_SIDECAR, "utf8");
    await chmod(devPath, 0o755);

    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    configPath = await context.writeConfig(
      "tmux-env-argv.yaml",
      `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    sidecars:
      dev:
        command: "${devPath}"
        autoStart: false
`,
    );
    const daemon = await context.startDaemon(configPath);
    daemonPid = daemon.info.pid;
  });

  afterAll(async () => {
    for (const pid of sidecarPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await stopDaemonByPid(daemonPid);
    await killTmuxSessionsByPrefix(sessionPrefix, context.tmuxSocketName);
    await context.cleanup();
  });

  it("delivers the daemon env to the agent pane and the sidecar pane without it touching tmux argv", async () => {
    const session = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "argv env", "--json"]))
        .stdout,
    ) as SessionView;
    const response = await fetch(
      `http://127.0.0.1:${context.port}/sessions/${session.id}/sidecars/dev/start`,
      { method: "POST", signal: AbortSignal.timeout(90_000) },
    );
    expect(response.status, await response.text()).toBe(200);

    // Sidecar pane: the script's own `printenv` result.
    const sentinelFile = join(session.worktreePath, `.sentinel-dev-${session.id}`);
    const sidecarValue = await pollUntil(
      async () => {
        try {
          return (await readFile(sentinelFile, "utf8")).trim();
        } catch {
          return null;
        }
      },
      { timeoutMs: 15_000, accept: (value) => value !== null, label: "sidecar sentinel file" },
    );
    const pid = Number.parseInt(
      (await readFile(join(session.worktreePath, `.pid-dev-${session.id}`), "utf8")).trim(),
      10,
    );
    if (Number.isInteger(pid) && processAlive(pid)) sidecarPids.add(pid);
    expect(sidecarValue === sentinel).toBe(true);

    // Agent pane: the pane process's own environ, asserted by inclusion only.
    const environ = (await pollUntil(() => readPaneEnviron(session.id), {
      timeoutMs: 15_000,
      accept: (value) => value !== null,
      label: "agent pane environ",
    })) as Buffer;
    expect(environ.includes(`SPUR_TEST_ARGV_SENTINEL=${sentinel}`)).toBe(true);

    // The daemon ran real new-session/respawn-pane calls (both panes exist),
    // and none of them carried the value.
    const argvBytes = await readFile(argvLog);
    expect(argvBytes.includes("new-session")).toBe(true);
    expect(argvBytes.includes("respawn-pane")).toBe(true);
    expect(argvBytes.includes(sentinel)).toBe(false);

    // Both panes consumed their env files: nothing left in the session tool
    // dir (read from the pane's own env) or the daemon's TMPDIR.
    const toolDirEntry = environ
      .toString("utf8")
      .split("\0")
      .find((entry) => entry.startsWith("SPUR_SESSION_TOOL_DIR="));
    const toolDir = toolDirEntry?.slice("SPUR_SESSION_TOOL_DIR=".length);
    expect(toolDir).toBeTruthy();
    await pollUntil(
      async () =>
        (await paneEnvFiles(toolDir as string)).length + (await paneEnvFiles(daemonTmpDir)).length,
      { timeoutMs: 10_000, accept: (count) => count === 0, label: "pane env files consumed" },
    );
  });
});
