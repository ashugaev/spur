import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_USE_STALE_MS } from "../../src/claude-jsonl-state.js";
import { readEventLog, type SpurLogEntry } from "../../src/event-log.js";
import type { RuntimeInfo, ServiceInstanceView, SessionView } from "../../src/types.js";
import { execFileAsync, findFreePort, pollUntil, sleep } from "../helpers/common.js";
import {
  CLI_PATH,
  captureTmuxPane,
  createGitRepo,
  createRuntimeTestContext,
  createTmuxSession,
  execTmux,
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  readTmuxOption,
  sendKeysToTmux,
  syncTmuxEnvironment,
  tmuxSessionExists,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

const activeContexts: Array<{
  context: RuntimeTestContext;
  daemonPid?: number;
  sessionPrefix: string;
  controllerSessionName?: string;
}> = [];

function currentActiveContext(): (typeof activeContexts)[number] {
  const current = activeContexts.at(-1);
  if (!current) {
    throw new Error("Expected an active runtime context");
  }
  return current;
}

function popActiveContext(): (typeof activeContexts)[number] {
  const current = activeContexts.pop();
  if (!current) {
    throw new Error("Expected an active runtime context to clean up");
  }
  return current;
}

function baseConfig(
  context: RuntimeTestContext,
  sessionPrefix: string,
  extraProjectYaml = "",
): string {
  return `server:
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
    symlinks:
      - .env
${extraProjectYaml}
`;
}

async function writeSidecarDepthRecorder(
  context: RuntimeTestContext,
  scriptName: string,
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_SIDECAR_DEPTH:-}" > ".sidecar-depth-\${SPUR_SIDECAR_NAME:?}-\${SPUR_SESSION:?}"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function sidecarDepthPath(worktreePath: string, sessionId: string, sidecarName: string): string {
  return join(worktreePath, `.sidecar-depth-${sidecarName}-${sessionId}`);
}

function sessionSidecarHelperPath(context: RuntimeTestContext, sessionId: string): string {
  return join(context.dataDir, "session-tools", sessionId, "spur-sidecar");
}

async function installFakeDesktopNotifier(context: RuntimeTestContext): Promise<string> {
  const logPath = join(context.rootDir, "desktop-notify.log");
  const binary = process.platform === "darwin" ? "osascript" : "notify-send";
  await writeFile(
    join(context.fakeBinDir, binary),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`,
    "utf8",
  );
  await chmod(join(context.fakeBinDir, binary), 0o755);
  return logPath;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pid="]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .includes(String(pid));
  } catch {
    return false;
  }
}

async function runRestoreScenario(args: {
  agent?: "claude" | "codex";
  configName: string;
  stopMode?: "exit" | "pause";
  expectRestorePrompt?: boolean;
}): Promise<{
  context: RuntimeTestContext;
  restored: SessionView[];
  spawned: SessionView;
  pane: string;
}> {
  const port = await findFreePort();
  const context = await createRuntimeTestContext(port);
  const sessionPrefix = `rt-restore-${args.agent ?? "claude"}-${port}`;
  activeContexts.push({ context, sessionPrefix });
  await syncTmuxEnvironment({
    HOME: context.env.HOME,
    PATH: context.env.PATH,
    SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
    SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
  });
  const configPath = await context.writeConfig(args.configName, baseConfig(context, sessionPrefix));
  const daemon = await context.startDaemon(configPath);
  currentActiveContext().daemonPid = daemon.info.pid;

  const spawnArgs = ["--config", configPath, "spawn", "api", "restore runtime prompt"];
  if (args.agent) {
    spawnArgs.push("--agent", args.agent);
  }
  spawnArgs.push("--json");

  const spawned = JSON.parse((await context.execCli(spawnArgs)).stdout) as SessionView;
  const expectedResumeId =
    (args.agent ?? "claude") === "codex" ? `thread-${spawned.id}` : `fake-claude-${spawned.id}`;
  const stopMode = args.stopMode ?? "exit";
  const expectRestorePrompt = args.expectRestorePrompt ?? true;
  const restorePrompt = "This session was restored after the agent exited.";
  const readyMarker = (args.agent ?? "claude") === "codex" ? "›" : "❯";

  if (stopMode === "pause") {
    const paused = JSON.parse(
      (await context.execCli(["--config", configPath, "pause", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(paused.status).toBe("stopped");
    expect(paused.runtimeAlive).toBe(false);
    expect(paused.workspaceExists).toBe(true);
  } else {
    await context.execCli(["--config", configPath, "send", spawned.id, "exit-now", "--json"]);
  }

  const exited = await pollUntil(
    async () =>
      JSON.parse(
        (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
      ) as SessionView[],
    {
      timeoutMs: 15_000,
      accept: (value) =>
        value[0]?.state === "stopped" &&
        value[0]?.runtimeAlive === (stopMode === "exit") &&
        value[0]?.status === "stopped",
    },
  );
  expect(exited[0]?.workspaceExists).toBe(true);

  const controllerSessionName = `${sessionPrefix}-ui`;
  currentActiveContext().controllerSessionName = controllerSessionName;
  await createTmuxSession({
    sessionName: controllerSessionName,
    cwd: context.rootDir,
    command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
    env: {
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    },
  });

  await pollUntil(async () => captureTmuxPane(controllerSessionName), {
    timeoutMs: 15_000,
    accept: (value) => value.includes("Sessions"),
  });

  await sendKeysToTmux(controllerSessionName, "r");
  await sleep(1_000);
  await sendKeysToTmux(controllerSessionName, "q");

  const restored = await pollUntil(
    async () =>
      JSON.parse(
        (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
      ) as SessionView[],
    {
      timeoutMs: 15_000,
      accept: (value) => value[0]?.state !== "stopped" && value[0]?.runtimeAlive === true,
    },
  );

  const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
    timeoutMs: 15_000,
    accept: (value) =>
      expectRestorePrompt
        ? value.includes(restorePrompt)
        : value.includes(readyMarker) && !value.includes(restorePrompt),
  });

  const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
    timeoutMs: 15_000,
    accept: (value) => value.includes(`startup:resume:${expectedResumeId}:`),
  });

  expect(log).toContain(`startup:resume:${expectedResumeId}:`);
  expect(restored[0]?.runtimeAlive).toBe(true);
  expect(existsSync(restored[0]?.worktreePath ?? "")).toBe(true);
  if (expectRestorePrompt) {
    expect(pane).toContain("Original task:");
  } else {
    expect(pane).not.toContain(restorePrompt);
  }

  return { context, restored, spawned, pane };
}

async function stopDaemonByPid(pid?: number): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

describe.skipIf(!tmuxOk)("Spur CLI lifecycle (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = popActiveContext();
      await stopDaemonByPid(current.daemonPid);
      if (current.controllerSessionName) {
        await killTmuxSession(current.controllerSessionName);
      }
      await killTmuxSessionsByPrefix(current.sessionPrefix);
      await current.context.cleanup();
    }
  });

  it.each(["list", "ls"])(
    "auto-starts the daemon for %s --json and returns an empty array",
    async (command) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-auto-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig("auto.yaml", baseConfig(context, sessionPrefix));

      const { stdout } = await context.execCli(["--config", configPath, command, "--json"]);
      const sessions = JSON.parse(stdout) as SessionView[];
      const info = await context.fetchJson<RuntimeInfo>("/info");
      currentActiveContext().daemonPid = info.pid;

      expect(sessions).toEqual([]);
      expect(info.host).toBe("127.0.0.1");
      expect(info.port).toBe(port);
    },
  );

  it("stops the daemon through the built CLI and keeps stop as a no-op once it is down", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-daemon-stop-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "daemon-stop.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const stopped = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "stop", "--json"])).stdout,
    ) as { baseUrl: string; pid?: number; stopped: boolean };

    expect(stopped.stopped).toBe(true);
    expect(stopped.pid).toBe(daemon.info.pid);
    delete currentActiveContext().daemonPid;
    await expect(context.fetchJson("/info")).rejects.toThrow();

    const noop = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "stop", "--json"])).stdout,
    ) as { baseUrl: string; pid?: number; stopped: boolean };

    expect(noop).toEqual({
      baseUrl: `http://127.0.0.1:${port}`,
      stopped: false,
    });
    await expect(context.fetchJson("/info")).rejects.toThrow();
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "sends one desktop notification when a live session transitions to needs_input",
    async () => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-notify-${port}`;
      activeContexts.push({ context, sessionPrefix });
      const logPath = await installFakeDesktopNotifier(context);
      await syncTmuxEnvironment({
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig(
        "desktop-notify.yaml",
        baseConfig(context, sessionPrefix),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (await context.execCli(["--config", configPath, "spawn", "api", "notify me", "--json"]))
          .stdout,
      ) as SessionView;

      await context.execCli(["--config", configPath, "send", spawned.id, "show-waiting-menu"]);

      const firstNotification = await pollUntil(
        async () => (existsSync(logPath) ? readFile(logPath, "utf8") : ""),
        {
          timeoutMs: TOOL_USE_STALE_MS + 10_000,
          accept: (value) => value.includes(`Spur needs input [${spawned.id}]`),
        },
      );
      expect(firstNotification).toContain(`Spur needs input [${spawned.id}]`);

      await sleep(6_000);
      const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
      expect(log.match(new RegExp(`Spur needs input \\[${spawned.id}\\]`, "g"))).toHaveLength(1);
    },
  );

  it("restarts the daemon through the built CLI and keeps restart as a no-op once it is down", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-daemon-restart-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "daemon-restart.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const restarted = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "restart", "--json"])).stdout,
    ) as {
      baseUrl: string;
      previousPid?: number;
      restarted: boolean;
      runtime?: RuntimeInfo;
    };

    expect(restarted.restarted).toBe(true);
    expect(restarted.previousPid).toBe(daemon.info.pid);
    const restartedPid = restarted.runtime?.pid;
    expect(restartedPid).toBeTypeOf("number");
    if (typeof restartedPid !== "number") {
      throw new Error("Expected daemon restart to return a runtime pid");
    }
    currentActiveContext().daemonPid = restartedPid;

    const liveInfo = await context.fetchJson<RuntimeInfo>("/info");
    expect(liveInfo.pid).toBe(restartedPid);

    await context.execCli(["--config", configPath, "daemon", "stop", "--json"]);
    delete currentActiveContext().daemonPid;
    await expect(context.fetchJson("/info")).rejects.toThrow();

    const noop = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "restart", "--json"])).stdout,
    ) as {
      baseUrl: string;
      previousPid?: number;
      restarted: boolean;
      runtime?: RuntimeInfo;
    };

    expect(noop).toEqual({
      baseUrl: `http://127.0.0.1:${port}`,
      restarted: false,
    });
    await expect(context.fetchJson("/info")).rejects.toThrow();
  });

  it("reloads all registered projects after a restart from a different config path", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-registry-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const extraRepo = await createGitRepo();
    try {
      const baseConfigPath = await context.writeConfig(
        "registry-base.yaml",
        baseConfig(context, `${sessionPrefix}-api`),
      );
      const extraConfigPath = await context.writeConfig(
        "registry-extra.yaml",
        `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: codex
projects:
  web:
    path: ${extraRepo.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}-web
`,
      );

      const daemon = await context.startDaemon(baseConfigPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const extraSpawn = JSON.parse(
        (
          await context.execCli([
            "--config",
            extraConfigPath,
            "spawn",
            "web",
            "sync project",
            "--json",
          ])
        ).stdout,
      ) as SessionView;
      expect(extraSpawn.project).toBe("web");

      const restarted = JSON.parse(
        (await context.execCli(["--config", extraConfigPath, "daemon", "restart", "--json"]))
          .stdout,
      ) as {
        restarted: boolean;
        runtime?: RuntimeInfo;
      };
      expect(restarted.restarted).toBe(true);
      const restartedPid = restarted.runtime?.pid;
      expect(restartedPid).toBeTypeOf("number");
      if (typeof restartedPid === "number") {
        currentActiveContext().daemonPid = restartedPid;
      }

      const apiSpawn = await context.fetchJson<SessionView>("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "api",
          prompt: "registry survived restart",
          agent: "claude",
        }),
      });
      expect(apiSpawn.project).toBe("api");

      const listed = await context.fetchJson<SessionView[]>("/sessions");
      expect(listed.map((session) => session.project)).toEqual(
        expect.arrayContaining(["api", "web"]),
      );
    } finally {
      await rm(extraRepo.repoDir, { recursive: true, force: true });
      await rm(extraRepo.originDir, { recursive: true, force: true });
    }
  });

  it("keeps build as a no-op when /info is incompatible and does not expose a Spur runtime pid", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-build-noop-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "build-noop.yaml",
      baseConfig(context, sessionPrefix),
    );
    const repoRoot = join(import.meta.dirname, "..", "..", "..");
    const incompatibleServer = createServer((request, response) => {
      if (request.url === "/info") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ pid: 7777 }) + "\n");
        return;
      }
      response.writeHead(404);
      response.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        incompatibleServer.once("error", reject);
        incompatibleServer.listen(port, "127.0.0.1", () => {
          incompatibleServer.off("error", reject);
          resolve();
        });
      });

      await execFileAsync("pnpm", ["--dir", "v2", "build"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          SPUR_CONFIG: configPath,
        },
      });

      const response = await fetch(`http://127.0.0.1:${port}/info`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pid: 7777 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        incompatibleServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("rejects unknown options through the ls alias", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-ls-error-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "ls-error.yaml",
      baseConfig(context, sessionPrefix),
    );

    await expect(context.execCli(["--config", configPath, "ls", "--bogus"])).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown option '--bogus'"),
    });
  });

  it("surfaces spawn and lifecycle command errors through the built CLI without leaving session state behind", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-errors-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("errors.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli(["--config", configPath, "spawn", "missing", "bad prompt"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown project: missing"),
    });

    await expect(
      context.execCli(["--config", configPath, "send", "api-999", "follow up"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "pause", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "complete", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "kill", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "respawn", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed).toEqual([]);
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["daemon.started", "http.request.failed"]),
    );
  });

  it("respawns a completed session and rejects respawn for a running session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "respawn.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "respawn runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await expect(
      context.execCli(["--config", configPath, "respawn", spawned.id]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Session ${spawned.id} is not in a terminal state`),
    });

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(completed.status).toBe("completed");
    expect(completed.runtimeAlive).toBe(false);
    expect(completed.workspaceExists).toBe(false);

    const respawned = JSON.parse(
      (await context.execCli(["--config", configPath, "respawn", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(respawned.status).toBe("running");
    expect(respawned.project).toBe(spawned.project);

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed.map((session) => session.id)).toContain(respawned.id);

    const killed = JSON.parse(
      (await context.execCli(["--config", configPath, "kill", respawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(killed.status).toBe("killed");
    expect(killed.runtimeAlive).toBe(false);
    expect(killed.workspaceExists).toBe(false);
  });

  it("keeps kill and complete working for existing sessions after the project id is renamed", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-project-rename-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("rename.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const completeSession = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "complete me", "--json"]))
        .stdout,
    ) as SessionView;
    const killSession = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "kill me", "--json"])).stdout,
    ) as SessionView;

    await writeFile(
      configPath,
      `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  web:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}-web
    symlinks:
      - .env
`,
      "utf8",
    );

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", completeSession.id, "--json"]))
        .stdout,
    ) as SessionView;
    const killed = JSON.parse(
      (await context.execCli(["--config", configPath, "kill", killSession.id, "--json"])).stdout,
    ) as SessionView;
    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];

    expect(completed.status).toBe("completed");
    expect(completed.workspaceExists).toBe(false);
    expect(killed.status).toBe("killed");
    expect(killed.workspaceExists).toBe(false);
    expect(listed).toEqual([]);
  });

  it("complete after a project rename still tears down sidecar tmux and processes", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-project-rename-sidecar-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = join(context.repoDir, "record-dev-sidecar.sh");
    await writeFile(
      sidecarPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" > ".sidecar-pid-\${SPUR_SESSION:?}"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
      "utf8",
    );
    await chmod(sidecarPath, 0o755);
    const configPath = await context.writeConfig(
      "rename-sidecar.yaml",
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
    symlinks:
      - .env
    sidecars:
      dev:
        command: "${sidecarPath}"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "rename sidecar complete",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const devSessionName = `${spawned.id}--dev`;
    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    const sidecarPid = Number.parseInt(
      await pollUntil(
        async () =>
          readFile(join(spawned.worktreePath, `.sidecar-pid-${spawned.id}`), "utf8").catch(
            () => "",
          ),
        { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
      ),
      10,
    );
    expect(Number.isInteger(sidecarPid)).toBe(true);
    expect(await processExists(sidecarPid)).toBe(true);

    await writeFile(
      configPath,
      `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  web:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}-web
    symlinks:
      - .env
`,
      "utf8",
    );

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(completed.status).toBe("completed");
    expect(completed.workspaceExists).toBe(false);

    const devSessionGone = !(await tmuxSessionExists(devSessionName));
    expect(devSessionGone).toBe(true);
    await pollUntil(() => processExists(sidecarPid), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });
  });

  it("creates a new worktree branch from a per-spawn worktree base override", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-default-branch-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    await execFileAsync("git", ["checkout", "-b", "release"], { cwd: context.repoDir });
    await writeFile(join(context.repoDir, "RELEASE.txt"), "release branch\n", "utf8");
    await execFileAsync("git", ["add", "RELEASE.txt"], { cwd: context.repoDir });
    await execFileAsync("git", ["commit", "-m", "release base"], { cwd: context.repoDir });
    await execFileAsync("git", ["checkout", "main"], { cwd: context.repoDir });
    const configPath = await context.writeConfig(
      "default-branch.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "default branch prompt",
          "--worktree",
          "release",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const { stdout } = await execFileAsync("git", ["show", "HEAD:RELEASE.txt"], {
      cwd: spawned.worktreePath,
    });

    expect(spawned.branch).toBe(spawned.id);
    expect(stdout.trim()).toBe("release branch");
  });

  it.each(["claude", "codex"] as const)(
    "uses %s spawn preflight to derive the worktree branch through the built CLI",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-preflight-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const expectedBranch = `feature/${agent}-runtime-preflight`;
      const configPath = await context.writeConfig(
        `${agent}-preflight.yaml`,
        baseConfig(
          context,
          sessionPrefix,
          `    preflight:
      prompt: "Use branch hint: ${expectedBranch}"
`,
        ),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            `runtime preflight prompt for ${agent}`,
            "--agent",
            agent,
            "--json",
          ])
        ).stdout,
      ) as SessionView;

      const branch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: spawned.worktreePath,
      });

      expect(spawned.branch).toBe(expectedBranch);
      expect(spawned.branchSource).toBe("preflight");
      expect(branch.stdout.trim()).toBe(expectedBranch);
    },
  );

  it("falls back to a fresh session branch when respawn preflight picks a branch already used by another worktree", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-occupied-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const occupiedBranch = "feature/respawn-occupied";
    const configPath = await context.writeConfig(
      "respawn-occupied.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    preflight:
      prompt: "Use branch hint: ${occupiedBranch}"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "runtime respawn occupied prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    expect(spawned.branch).toBe(occupiedBranch);

    await context.execCli(["--config", configPath, "complete", spawned.id, "--json"]);

    const occupiedWorktreePath = join(context.rootDir, "occupied-respawn-branch");
    await execFileAsync("git", ["worktree", "add", occupiedWorktreePath, occupiedBranch], {
      cwd: context.repoDir,
    });

    try {
      const respawned = JSON.parse(
        (await context.execCli(["--config", configPath, "respawn", spawned.id, "--json"])).stdout,
      ) as SessionView;

      expect(respawned.status).toBe("running");
      expect(respawned.branch).toBe(respawned.id);

      const branch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: respawned.worktreePath,
      });
      expect(branch.stdout.trim()).toBe(respawned.id);
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", occupiedWorktreePath], {
        cwd: context.repoDir,
      });
    }
  });

  it.each(["claude", "codex"] as const)(
    "falls back to session-id branch naming when %s preflight returns empty output",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-preflight-empty-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig(
        `${agent}-preflight-empty.yaml`,
        baseConfig(
          context,
          sessionPrefix,
          `    preflight:
      prompt: "Return empty preflight output"
`,
        ),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            `runtime empty preflight prompt for ${agent}`,
            "--agent",
            agent,
            "--json",
          ])
        ).stdout,
      ) as SessionView;

      expect(spawned.branch).toBe(spawned.id);
      expect(spawned.branchSource).toBeUndefined();

      const branch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: spawned.worktreePath,
      });
      expect(branch.stdout.trim()).toBe(spawned.id);

      await context.execCli(["--config", configPath, "complete", spawned.id, "--json"]);

      const respawned = JSON.parse(
        (await context.execCli(["--config", configPath, "respawn", spawned.id, "--json"])).stdout,
      ) as SessionView;

      expect(respawned.branch).toBe(respawned.id);
      expect(respawned.branchSource).toBeUndefined();

      const respawnedBranch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: respawned.worktreePath,
      });
      expect(respawnedBranch.stdout.trim()).toBe(respawned.id);
    },
  );

  it("rejects an explicit branch when another worktree already has it checked out", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-branch-conflict-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const occupiedBranch = "feature/branch-conflict";
    const occupiedWorktreePath = join(context.rootDir, "occupied-explicit-branch");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", occupiedBranch, occupiedWorktreePath, "main"],
      { cwd: context.repoDir },
    );

    try {
      const configPath = await context.writeConfig(
        "branch-conflict.yaml",
        baseConfig(context, sessionPrefix),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      await expect(
        context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "runtime explicit branch conflict",
          "--branch",
          occupiedBranch,
          "--json",
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `branch "${occupiedBranch}" is already checked out in worktree ${occupiedWorktreePath}`,
        ),
      });
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", occupiedWorktreePath], {
        cwd: context.repoDir,
      });
    }
  });

  it("fetches origin before spawn so the worktree and local base branch use the freshest main", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-fresh-main-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const remoteRepoDir = join(context.rootDir, "origin-main-clone");
    await execFileAsync("git", ["clone", "--quiet", context.originDir, remoteRepoDir]);
    try {
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: remoteRepoDir,
      });
      await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: remoteRepoDir });
      await writeFile(join(remoteRepoDir, "REMOTE.txt"), "fresh main\n", "utf8");
      await execFileAsync("git", ["add", "REMOTE.txt"], { cwd: remoteRepoDir });
      await execFileAsync("git", ["commit", "-m", "remote main update"], { cwd: remoteRepoDir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: remoteRepoDir });
    } finally {
      await rm(remoteRepoDir, { recursive: true, force: true });
    }

    await expect(
      execFileAsync("git", ["show", "main:REMOTE.txt"], { cwd: context.repoDir }),
    ).rejects.toThrow();

    const configPath = await context.writeConfig(
      "fresh-main.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "fresh main prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const worktreeFile = await execFileAsync("git", ["show", "HEAD:REMOTE.txt"], {
      cwd: spawned.worktreePath,
    });
    const localMainFile = await execFileAsync("git", ["show", "main:REMOTE.txt"], {
      cwd: context.repoDir,
    });

    expect(worktreeFile.stdout.trim()).toBe("fresh main");
    expect(localMainFile.stdout.trim()).toBe("fresh main");
  });

  it("uses origin/main for spawn when checked-out main is dirty and origin/main is ahead", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-dirty-main-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const remoteRepoDir = join(context.rootDir, "origin-dirty-main-clone");
    await execFileAsync("git", ["clone", "--quiet", context.originDir, remoteRepoDir]);
    try {
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: remoteRepoDir,
      });
      await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: remoteRepoDir });
      await writeFile(join(remoteRepoDir, "REMOTE_DIRTY.txt"), "fresh remote\n", "utf8");
      await execFileAsync("git", ["add", "REMOTE_DIRTY.txt"], { cwd: remoteRepoDir });
      await execFileAsync("git", ["commit", "-m", "remote main update for dirty branch"], {
        cwd: remoteRepoDir,
      });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: remoteRepoDir });
    } finally {
      await rm(remoteRepoDir, { recursive: true, force: true });
    }

    await writeFile(join(context.repoDir, "LOCAL_DIRTY.txt"), "local dirty change\n", "utf8");

    await expect(
      execFileAsync("git", ["show", "main:REMOTE_DIRTY.txt"], { cwd: context.repoDir }),
    ).rejects.toThrow();

    const configPath = await context.writeConfig(
      "dirty-main.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dirty main prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const worktreeFile = await execFileAsync("git", ["show", "HEAD:REMOTE_DIRTY.txt"], {
      cwd: spawned.worktreePath,
    });
    const localDirtyStatus = await execFileAsync(
      "git",
      ["status", "--short", "--", "LOCAL_DIRTY.txt"],
      {
        cwd: context.repoDir,
      },
    );

    await expect(
      execFileAsync("git", ["show", "main:REMOTE_DIRTY.txt"], { cwd: context.repoDir }),
    ).rejects.toThrow();
    expect(worktreeFile.stdout.trim()).toBe("fresh remote");
    expect(localDirtyStatus.stdout).toContain("LOCAL_DIRTY.txt");
  });

  it("spawns and kills a shared workspace session without removing the project path", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-shared-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "shared.yaml",
      `${baseConfig(context, sessionPrefix)}    worktree: false\n`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "shared workspace prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    expect(spawned.worktree).toBe(false);
    expect(spawned.worktreePath).toBe(context.repoDir);
    expect(spawned.branchSource).toBe("shared_workspace");

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("shared workspace prompt"),
    });

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "shared workspace follow up",
      "--json",
    ]);

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("shared workspace follow up"),
    });

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "k");

    const killed = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "killed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === true,
      },
    );

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );

    expect(listed).toEqual([]);
    expect(killed.worktree).toBe(false);
    expect(existsSync(context.repoDir)).toBe(true);
  });

  it("pauses, resumes, and completes a worktree session through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pause-complete-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pause-complete.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "pause and complete prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("pause and complete prompt"),
    });

    const paused = JSON.parse(
      (await context.execCli(["--config", configPath, "pause", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(paused.status).toBe("stopped");
    expect(paused.runtimeAlive).toBe(false);
    expect(paused.workspaceExists).toBe(true);
    expect(existsSync(spawned.worktreePath)).toBe(true);

    const pausedList = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value[0]?.id === spawned.id &&
          value[0]?.status === "stopped" &&
          value[0]?.state === "stopped" &&
          value[0]?.runtimeAlive === false &&
          value[0]?.workspaceExists === true,
      },
    );
    expect(pausedList).toHaveLength(1);

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "resume after pause",
      "--json",
    ]);

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("resume after pause"),
    });

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(completed.status).toBe("completed");
    expect(completed.runtimeAlive).toBe(false);
    expect(completed.workspaceExists).toBe(false);
    expect(existsSync(spawned.worktreePath)).toBe(false);

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );
    expect(listed).toEqual([]);

    const stored = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "completed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );
    expect(stored.status).toBe("completed");

    await expect(
      context.execCli(["--config", configPath, "send", spawned.id, "after complete"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Session is not running: ${spawned.id}`),
    });
  });

  it("pauses and completes a session through the interactive list", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-list-pause-complete-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "list-pause-complete.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "interactive pause and complete",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "p");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`Stopped ${spawned.id}.`),
    });

    const pausedList = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value[0]?.id === spawned.id &&
          value[0]?.status === "stopped" &&
          value[0]?.state === "stopped" &&
          value[0]?.runtimeAlive === false &&
          value[0]?.workspaceExists === true,
      },
    );
    expect(pausedList).toHaveLength(1);

    await sendKeysToTmux(controllerSessionName, "c");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes(`Completed ${spawned.id}.`) && value.includes("No sessions."),
    });

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );
    expect(listed).toEqual([]);

    const stored = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "completed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );
    expect(stored.status).toBe("completed");

    await sendKeysToTmux(controllerSessionName, "q");
  });

  it("rejects a shared-workspace branch override through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-shared-branch-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "shared-branch.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli([
        "--config",
        configPath,
        "spawn",
        "api",
        "bad branch override",
        "--shared",
        "--branch",
        "feature/shared",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "branch override requires worktree=true; shared workspace is on branch main",
      ),
    });

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed).toEqual([]);
  });

  it("updates live session slots through the helper command and refreshes tmux status", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-slots-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("slots.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "slot runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur-slots");
    expect(existsSync(helperPath)).toBe(true);

    await execFileAsync(helperPath, [
      "--title",
      "Investigate status bar links",
      "--link",
      "tracker=https://tracker.example.com/TASK-9",
      "--link",
      "github-pr=https://github.com/org/repo/pull/9",
    ]);

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value[0]?.slots?.title === "Investigate status bar links" &&
          value[0]?.slots?.links?.length === 2,
      },
    );

    const statusLeft = await readTmuxOption(spawned.id, "status-left");
    const statusRight = await readTmuxOption(spawned.id, "status-right");
    const { stdout: mouseBinding } = await execTmux([
      "list-keys",
      "-T",
      "root",
      "MouseUp1StatusRight",
    ]);

    expect(listed[0]?.slots).toEqual({
      title: "Investigate status bar links",
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-9" },
        { label: "github-pr", url: "https://github.com/org/repo/pull/9" },
      ],
    });
    expect(statusLeft).toContain("Investigate status bar links");
    expect(statusRight).toContain("tracker TASK-9");
    expect(statusRight).toContain("github pr ##9");
    expect(statusRight).toContain(
      "#[hyperlink=https://tracker.example.com/TASK-9]tracker TASK-9#[hyperlink=]",
    );
    expect(statusRight).toContain(
      "#[hyperlink=https://github.com/org/repo/pull/9]github pr ##9#[hyperlink=]",
    );
    expect(mouseBinding).toContain("MouseUp1StatusRight");
    expect(mouseBinding).toContain("open-link.js");
    expect(mouseBinding).toContain("q:mouse_hyperlink");
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toContain(
      "session.slots.updated",
    );
  });

  it("surfaces session artifacts from daemon-owned storage and removes them on complete", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-artifacts-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "artifacts.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "artifact runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const artifactDir = join(context.dataDir, "session-artifacts", spawned.id);
    const artifactPath = join(artifactDir, "capture.png");
    await writeFile(artifactPath, "artifact-bytes", "utf8");

    const sessionWithArtifact = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) => value.artifacts?.[0]?.id === "capture.png",
      },
    );
    expect(sessionWithArtifact.artifacts?.[0]).toMatchObject({
      id: "capture.png",
      kind: "image",
    });

    const response = await fetch(
      `http://127.0.0.1:${daemon.info.port}/sessions/${spawned.id}/artifacts/capture.png`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    await expect(response.text()).resolves.toBe("artifact-bytes");

    await context.execCli(["--config", configPath, "complete", spawned.id, "--json"]);
    expect(existsSync(artifactDir)).toBe(false);

    const missing = await fetch(
      `http://127.0.0.1:${daemon.info.port}/sessions/${spawned.id}/artifacts/capture.png`,
    );
    expect(missing.status).toBe(404);
  });

  it("serves artifact files whose names require URL encoding", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-artifacts-encoded-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "artifacts-encoded.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "artifact encoded runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const artifactDir = join(context.dataDir, "session-artifacts", spawned.id);
    await writeFile(join(artifactDir, "my screenshot.png"), "artifact-bytes", "utf8");

    const sessionWithArtifact = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) => value.artifacts?.some((artifact) => artifact.id === "my screenshot.png"),
      },
    );
    expect(
      sessionWithArtifact.artifacts?.some((artifact) => artifact.id === "my screenshot.png"),
    ).toBe(true);

    const response = await fetch(
      `http://127.0.0.1:${daemon.info.port}/sessions/${spawned.id}/artifacts/my%20screenshot.png`,
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("artifact-bytes");
  });

  it("runs a session-bound service and opens the live session log view from the TTY list", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "service.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    sources:
      web-watch:
        type: service
        service: web
        intervalMs: 500
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers: {}
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "service runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur");

    const runResult = JSON.parse(
      (
        await execFileAsync(
          helperPath,
          [
            "service",
            "run",
            "web",
            "--port",
            "3000",
            "--json",
            "--",
            "sh",
            "-lc",
            `'printf "SERVICE_BOOT\\n"; sleep 30'`,
          ],
          {
            cwd: spawned.worktreePath,
            env: {
              ...context.env,
              SPUR_SESSION: spawned.id,
            },
          },
        )
      ).stdout,
    ) as ServiceInstanceView;

    expect(runResult.serviceId).toBe("web");
    expect(runResult.port).toBe(3000);

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (
            await context.execCli([
              "--config",
              configPath,
              "service",
              "status",
              spawned.id,
              "--json",
            ])
          ).stdout,
        ) as ServiceInstanceView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value[0]?.serviceId === "web" && value[0]?.runtimeAlive === true,
      },
    );
    expect(listed).toHaveLength(1);

    const detail = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "service",
          "status",
          spawned.id,
          "web",
          "--json",
        ])
      ).stdout,
    ) as ServiceInstanceView;
    expect(detail.tmuxSession).toBe(`${spawned.id}--svc--web`);
    expect(detail.port).toBe(3000);
    expect(detail.state).toBe("running");

    const helperLogs = JSON.parse(
      (
        await execFileAsync(helperPath, ["service", "logs", "--json"], {
          cwd: spawned.worktreePath,
          env: {
            ...context.env,
            SPUR_SESSION: spawned.id,
          },
        })
      ).stdout,
    ) as SpurLogEntry[];
    expect(helperLogs).toEqual([]);

    const controllerSessionName = `${sessionPrefix}-service-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    const attachedPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("l logs"),
    });
    expect(attachedPane).toContain("service web:3000:running");

    await sendKeysToTmux(controllerSessionName, "l");

    const logPane = await pollUntil(async () => captureTmuxPane(controllerSessionName, 1000), {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes(`Logs ${spawned.id}`) &&
        value.includes("session.spawn.completed") &&
        value.includes("service.run.completed") &&
        value.includes("(runtime log capture unavailable)"),
    });
    expect(logPane).toContain("service.run.completed");
    expect(logPane).toContain("Agent Output");
    expect(logPane).toContain("(runtime log capture unavailable)");
    expect(logPane).not.toContain("SERVICE_BOOT");

    await sendKeysToTmux(controllerSessionName, "C-g");

    const detachedPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("l logs"),
    });
    expect(detachedPane).toContain("l logs");
  });

  it("returns an empty sidecar log result when runtime log capture is disabled", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-logs-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = join(context.repoDir, "record-browser-sidecar.sh");
    await writeFile(
      sidecarPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'BROWSER_READY\n'
sleep 30
`,
      "utf8",
    );
    await chmod(sidecarPath, 0o755);
    const configPath = await context.writeConfig(
      "sidecar-logs.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      browser:
        command: "./record-browser-sidecar.sh"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "browser logs", "--json"]))
        .stdout,
    ) as SessionView;

    const sidecarLogs = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "service",
          "logs",
          spawned.id,
          "browser",
          "--sidecar",
          "--json",
        ])
      ).stdout,
    ) as SpurLogEntry[];
    expect(sidecarLogs).toEqual([]);
  });

  it("surfaces service command errors through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-errors-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "service-errors.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    sources:
      web-watch:
        type: service
        service: web
        intervalMs: 500
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers: {}
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "service error prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur");

    await expect(
      context.execCli(
        ["--config", configPath, "service", "run", "web", "--json", "--", "echo", "hi"],
        { env: { SPUR_SESSION: "" } },
      ),
    ).rejects.toThrow("service run requires a live Spur session");

    await expect(
      context.execCli(["--config", configPath, "service", "status", "api-999", "--json"]),
    ).rejects.toThrow("Session not found: api-999");

    await execFileAsync(
      helperPath,
      ["service", "run", "web", "--json", "--", "sh", "-lc", `'printf "SERVICE_DONE\\n"; sleep 1'`],
      {
        cwd: spawned.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: spawned.id,
        },
      },
    );

    const stopped = await pollUntil(
      async () =>
        JSON.parse(
          (
            await context.execCli([
              "--config",
              configPath,
              "service",
              "status",
              spawned.id,
              "web",
              "--json",
            ])
          ).stdout,
        ) as ServiceInstanceView,
      {
        timeoutMs: 20_000,
        accept: (value) => value.runtimeAlive === false,
      },
    );
    expect(["stopped", "error"]).toContain(stopped.state);
  });

  it("rejects service logs without a session id outside a Spur session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-logs-errors-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "service-logs-errors.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli(["--config", configPath, "service", "logs", "--json"], {
        env: { SPUR_SESSION: "" },
      }),
    ).rejects.toThrow("service logs requires a session id or SPUR_SESSION");
  });

  it("rejects invalid or missing slot targets through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-slots-error-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "slots-error.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli([
        "--config",
        configPath,
        "slots",
        "--session",
        "api-999",
        "--title",
        "missing session",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli([
        "--config",
        configPath,
        "slots",
        "--session",
        "api-999",
        "--link",
        "broken",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--link must use label=url"),
    });
  });

  it("spawns, sends, and kills a session through the interactive list", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cli-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("cli.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "initial runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("initial runtime prompt"),
    });

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "follow up runtime prompt",
      "--json",
    ]);

    const paneAfterSend = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("follow up runtime prompt"),
    });
    expect(paneAfterSend).toContain("initial runtime prompt");

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.runtimeAlive).toBe(true);
    expect(listed[0]?.workspaceExists).toBe(true);

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "k");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`Killed ${spawned.id}.`),
    });

    const killed = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "killed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );

    const listedAfterKill = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );

    expect(listedAfterKill).toEqual([]);
    expect(killed.status).toBe("killed");
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "daemon.started",
        "session.spawn.completed",
        "session.message.sent",
        "session.kill.completed",
      ]),
    );

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("No sessions."),
    });

    await sendKeysToTmux(controllerSessionName, "q");
  });

  it("keeps manual spawn as one task prompt through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pipeline-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pipeline.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "ship the task", "--json"]))
        .stdout,
    ) as SessionView;

    const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });
    const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });

    expect(pane).toContain("ship the task");
    expect(log).toContain("ship the task");
  });

  it("spawns a session through the built CLI without sending an initial prompt", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-empty-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "empty-prompt.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - research
        - test
    preflight:
      prompt: Suggest a branch name from the task context.
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "--json"])).stdout,
    ) as SessionView;

    expect(spawned.prompt).toBe("");
    expect(spawned.pipeline).toBeUndefined();

    const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Claude Code") && value.includes("❯"),
    });
    const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("startup:launch::"),
    });
    const listed = await context.fetchJson<SessionView[]>("/sessions");

    expect(log).toContain("startup:launch::");
    expect(log).not.toContain("research");
    expect(log).not.toContain("[Spur step");
    expect(pane).not.toContain("[Spur step");
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.prompt).toBe("");
    expect(listed[0]?.pipeline).toBeUndefined();
  });

  it.each([
    { agent: "claude", expectPlanFlag: true },
    { agent: "codex", expectPlanFlag: false },
  ] as const)(
    "accepts --plan for $agent and applies startup behavior only where supported",
    async (row) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-plan-${row.agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig(
        "plan-flag.yaml",
        baseConfig(context, sessionPrefix),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            "plan mode check",
            "--agent",
            row.agent,
            "--plan",
            "--json",
          ])
        ).stdout,
      ) as SessionView;

      expect(spawned.planMode).toBe(true);
      const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("startup:launch::"),
      });
      if (row.expectPlanFlag) {
        expect(log).toContain("--permission-mode");
        expect(log).toContain("plan");
      } else {
        expect(log).not.toContain("--permission-mode");
      }
    },
  );

  it("uses project default spawn steps, paces later steps, and lets CLI steps override them", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pipeline-defaults-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pipeline-defaults.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - "research"
        - "test"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const defaultSpawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "ship the task", "--json"]))
        .stdout,
    ) as SessionView;

    const defaultPane = await pollUntil(async () => captureTmuxPane(defaultSpawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/2: research]"),
    });
    expect(defaultPane).toContain("ship the task");
    expect(defaultPane).toContain("[Spur step 1/2: research]");

    await sleep(5_000);
    const earlyDefaultLog = await context.readAgentLog(defaultSpawned.id);
    expect(earlyDefaultLog).not.toContain("[Spur step 2/2: test]");

    const defaultLog = await pollUntil(async () => context.readAgentLog(defaultSpawned.id), {
      timeoutMs: 45_000,
      accept: (value) => value.includes("[Spur step 2/2: test]"),
    });
    expect(defaultLog).toContain("[Spur step 2/2: test]");

    const overridden = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "ship the task",
          "--step",
          "review",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const overridePane = await pollUntil(async () => captureTmuxPane(overridden.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/1: review]"),
    });
    expect(overridePane).toContain("ship the task");
    expect(overridePane).toContain("[Spur step 1/1: review]");
    expect(overridePane).not.toContain("[Spur step 1/2: research]");
  });

  it("disables spawn steps in plan mode and sends the raw prompt", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-plan-no-steps-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "plan-no-steps.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - "research"
        - "test"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "ship the task",
          "--plan",
          "--step",
          "review",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    expect(spawned.planMode).toBe(true);
    expect(spawned.pipeline).toBeUndefined();
    const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });
    expect(pane).toContain("ship the task");
    expect(pane).not.toContain("[Spur step");

    const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });
    expect(log).toContain("ship the task");
    expect(log).not.toContain("[Spur step");
  });

  it("queues a busy manual send and delivers it before the next pipeline step", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-send-queue-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "send-queue.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - "research"
        - "test"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "ship the task", "--json"]))
        .stdout,
    ) as SessionView;

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/2: research]"),
    });

    await context.execCli(["--config", configPath, "send", spawned.id, "simulate-work", "--json"]);
    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "queued follow up",
      "--json",
    ]);

    await sleep(10_000);
    const earlyQueuedLog = await context.readAgentLog(spawned.id);
    expect(earlyQueuedLog).toContain("simulate-work");
    expect(earlyQueuedLog).not.toContain("queued follow up");

    const queuedLog = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 30_000,
      accept: (value) => value.includes("queued follow up"),
    });
    expect(queuedLog).toContain("simulate-work");
    expect(queuedLog).toContain("queued follow up");
    expect(queuedLog).not.toContain("[Spur step 2/2: test]");

    const finalLog = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 45_000,
      accept: (value) => value.includes("[Spur step 2/2: test]"),
    });
    expect(finalLog.indexOf("queued follow up")).toBeGreaterThan(-1);
    expect(finalLog.indexOf("[Spur step 2/2: test]")).toBeGreaterThan(
      finalLog.indexOf("queued follow up"),
    );
  });

  it("blocks kill from the interactive list when the worktree is dirty", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cli-dirty-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "cli-dirty.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dirty runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await writeFile(join(spawned.worktreePath, "DIRTY.txt"), "dirty change\n", "utf8");

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "k");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes(
          `Kill confirmation required for ${spawned.id}: uncommitted changes in its worktree. Press k again to kill anyway.`,
        ),
    });

    const sessionsAfterBlock = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(sessionsAfterBlock[0]?.status).toBe("running");
    expect(sessionsAfterBlock[0]?.runtimeAlive).toBe(true);
    expect(sessionsAfterBlock[0]?.workspaceExists).toBe(true);

    await expect(
      context.fetchJson(`/sessions/${spawned.id}/kill`, {
        method: "POST",
      }),
    ).rejects.toThrow(
      `Kill confirmation required for ${spawned.id}: uncommitted changes in its worktree`,
    );

    await sendKeysToTmux(controllerSessionName, "k");

    const killed = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "killed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );

    const listedAfterKill = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );
    expect(listedAfterKill).toEqual([]);
    expect(killed.status).toBe("killed");

    await sendKeysToTmux(controllerSessionName, "q");
  });

  it("requires confirmation before killing a session with unpushed commits", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cli-unpushed-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "cli-unpushed.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "unpushed runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await writeFile(join(spawned.worktreePath, "UNPUSHED.txt"), "unpushed change\n", "utf8");
    await execFileAsync("git", ["add", "UNPUSHED.txt"], { cwd: spawned.worktreePath });
    await execFileAsync("git", ["commit", "-m", "unpushed change"], { cwd: spawned.worktreePath });

    await expect(
      context.fetchJson(`/sessions/${spawned.id}/kill`, {
        method: "POST",
      }),
    ).rejects.toThrow(`Kill confirmation required for ${spawned.id}: unpushed commits`);

    const forced = await context.fetchJson<SessionView>(`/sessions/${spawned.id}/kill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe("killed");
    expect(forced.workspaceExists).toBe(false);
    expect(forced.runtimeAlive).toBe(false);
  });

  it("attaches in place from the TTY list and returns after detach", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-attach-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("attach.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await context.execCli([
      "--config",
      configPath,
      "spawn",
      "api",
      "attach runtime prompt",
      "--json",
    ]);

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "Enter");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Claude Code"),
    });

    await sendKeysToTmux(controllerSessionName, "C-g");

    const detachedPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Enter attach"),
    });

    expect(detachedPane).toContain(
      "Enter attach  l logs  p pause  c complete  r restore  k kill  Ctrl+G detach  Esc quit",
    );
  });

  it("restores an exited session in place from the TTY list", async () => {
    const result = await runRestoreScenario({ configName: "restore.yaml" });
    expect(result.spawned.agent).toBe("claude");
  });

  it("restores a manually stopped session in place without sending a restore prompt", async () => {
    const result = await runRestoreScenario({
      configName: "restore-paused.yaml",
      stopMode: "pause",
      expectRestorePrompt: false,
    });
    expect(result.spawned.agent).toBe("claude");
    expect(result.pane).not.toContain("This session was restored after the agent exited.");
  });

  it("restores a codex session through the native resume command", async () => {
    const result = await runRestoreScenario({ agent: "codex", configName: "restore-codex.yaml" });
    expect(result.spawned.agent).toBe("codex");
  });

  it("completes the calling live session after a session-bound respawn succeeds", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-parent-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "respawn-parent.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const caller = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "caller runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const target = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "respawn target prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    await context.execCli(["--config", configPath, "complete", target.id, "--json"]);

    const helperPath = join(context.dataDir, "session-tools", caller.id, "spur");
    const respawned = JSON.parse(
      (
        await execFileAsync(helperPath, ["respawn", target.id, "--json"], {
          cwd: caller.worktreePath,
          env: {
            ...context.env,
            SPUR_SESSION: caller.id,
            SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", caller.id),
          },
        })
      ).stdout,
    ) as SessionView;

    expect(respawned.id).not.toBe(target.id);
    expect(respawned.status).toBe("running");

    const completedCaller = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${encodeURIComponent(caller.id)}`),
      {
        timeoutMs: 15_000,
        accept: (session) =>
          session.status === "completed" &&
          session.runtimeAlive === false &&
          session.workspaceExists === false,
      },
    );
    expect(completedCaller.status).toBe("completed");
    expect(completedCaller.runtimeAlive).toBe(false);
    expect(completedCaller.workspaceExists).toBe(false);
  });

  it("keeps the calling live session running when a session-bound respawn fails", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-parent-fail-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "respawn-parent-fail.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const caller = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "caller runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", caller.id, "spur");

    await expect(
      execFileAsync(helperPath, ["respawn", "api-999", "--json"], {
        cwd: caller.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: caller.id,
          SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", caller.id),
        },
      }),
    ).rejects.toThrow("Session not found: api-999");

    const sessions = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    const liveCaller = sessions.find((session) => session.id === caller.id);
    expect(liveCaller?.status).toBe("running");
    expect(liveCaller?.runtimeAlive).toBe(true);
    expect(liveCaller?.workspaceExists).toBe(true);
  });

  it("falls back to a fresh launch in the TTY list when native resume state is missing", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-restore-missing-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "restore-missing.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "restore runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.execCli(["--config", configPath, "send", spawned.id, "exit-now", "--json"]);

    await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value[0]?.state === "stopped" && value[0]?.runtimeAlive === true,
      },
    );

    await rm(join(context.rootDir, ".claude"), { recursive: true, force: true });

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "r");
    const restored = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 30_000,
        accept: (value) => value[0]?.state !== "stopped" && value[0]?.runtimeAlive === true,
      },
    );
    const restoredPane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 30_000,
      accept: (value) => value.includes("This session was restored after the agent exited."),
    });

    await sendKeysToTmux(controllerSessionName, "q");

    expect(restored[0]?.id).toBe(spawned.id);
    expect(restored[0]?.runtimeAlive).toBe(true);
    expect(existsSync(restored[0]?.worktreePath ?? "")).toBe(true);
    expect(restoredPane).toContain("Original task:");
    expect(
      readEventLog(context.dataDir).some(
        (entry) =>
          entry.event === "session.restore.started" &&
          typeof entry.message === "string" &&
          entry.message.includes("falling back to fresh launch"),
      ),
    ).toBe(true);
  });

  it("POST /sessions/:id/sidecars/:name/start creates the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-start-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-start.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server start test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/dev/start`, {
      method: "POST",
    });

    const devSessionName = `${spawned.id}--dev`;
    const devSessionAlive = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 10_000,
      accept: (v) => v === true,
    });
    expect(devSessionAlive).toBe(true);
  });

  it("manual sidecar start and stop toggles the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-cli-stop-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-cli-stop.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    devServer:
      command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server cli stop test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${spawned.id}--dev`;
    await context.execCli([
      "--config",
      configPath,
      "sidecar",
      "start",
      "--session",
      spawned.id,
      "--name",
      "dev",
      "--json",
    ]);
    const devSessionAlive = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 10_000,
      accept: (v) => v === true,
    });
    expect(devSessionAlive).toBe(true);

    await context.execCli([
      "--config",
      configPath,
      "sidecar",
      "stop",
      "--session",
      spawned.id,
      "--name",
      "dev",
      "--json",
    ]);
    const devSessionStopped = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 10_000,
      accept: (v) => v === false,
    });
    expect(devSessionStopped).toBe(false);

    const sidecarEvents = readEventLog(context.dataDir)
      .map((e) => e.event)
      .filter((ev) => typeof ev === "string" && ev.startsWith("session.sidecar"));
    expect(sidecarEvents).toContain("session.sidecar.started");
    expect(sidecarEvents).toContain("session.sidecar.stopped");
  });

  it("hidden sidecar start command creates the configured sidecar tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-cli-start-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "sidecar-cli-start.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "sidecar cli start test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.execCli([
      "--config",
      configPath,
      "sidecar",
      "start",
      "--session",
      spawned.id,
      "--name",
      "dev",
      "--json",
    ]);

    const devSessionAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--dev`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(devSessionAlive).toBe(true);
  });

  it("spur-sidecar helper lets a first-level sidecar manually start one nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-helper-nested-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = await writeSidecarDepthRecorder(context, "record-nested-sidecar.sh");
    const configPath = await context.writeConfig(
      "sidecar-helper-nested.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
        autoStart: true
      preview:
        command: "${recorderPath}"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar helper test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--dev`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(devAlive).toBe(true);

    const helperPath = sessionSidecarHelperPath(context, spawned.id);
    await execFileAsync(helperPath, ["--name", "preview", "--json"], {
      cwd: spawned.worktreePath,
      env: {
        ...context.env,
        SPUR_SESSION: spawned.id,
        SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", spawned.id),
        SPUR_SIDECAR_DEPTH: "1",
        SPUR_SIDECAR_NAME: "dev",
      },
    });

    const previewAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--preview`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(previewAlive).toBe(true);

    const nestedDepth = await pollUntil(
      async () =>
        (
          await readFile(
            sidecarDepthPath(spawned.worktreePath, spawned.id, "preview"),
            "utf8",
          ).catch(() => "")
        ).trim(),
      {
        timeoutMs: 10_000,
        accept: (value) => value === "2",
      },
    );
    expect(nestedDepth).toBe("2");
  });

  it("spur-sidecar helper rejects callers already inside a nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-helper-reject-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = await writeSidecarDepthRecorder(context, "record-nested-sidecar.sh");
    const configPath = await context.writeConfig(
      "sidecar-helper-reject.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
        autoStart: true
      preview:
        command: "${recorderPath}"
      worker:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar reject test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const helperPath = sessionSidecarHelperPath(context, spawned.id);
    await execFileAsync(helperPath, ["--name", "preview", "--json"], {
      cwd: spawned.worktreePath,
      env: {
        ...context.env,
        SPUR_SESSION: spawned.id,
        SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", spawned.id),
        SPUR_SIDECAR_DEPTH: "1",
        SPUR_SIDECAR_NAME: "dev",
      },
    });

    await expect(
      execFileAsync(helperPath, ["--name", "worker", "--json"], {
        cwd: spawned.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: spawned.id,
          SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", spawned.id),
          SPUR_SIDECAR_DEPTH: "2",
          SPUR_SIDECAR_NAME: "preview",
        },
      }),
    ).rejects.toThrow("Sidecars can nest only one level deep");
    expect(await tmuxSessionExists(`${spawned.id}--worker`)).toBe(false);

    const rejectedEvent = await pollUntil(
      async () =>
        readEventLog(context.dataDir).find(
          (entry) =>
            entry.event === "session.sidecar.start_rejected" &&
            entry.sessionId === spawned.id &&
            entry.details?.["sidecarName"] === "worker",
        ),
      {
        timeoutMs: 10_000,
        accept: (value) => Boolean(value),
      },
    );
    expect(rejectedEvent).toMatchObject({
      details: expect.objectContaining({
        callerSidecarDepth: 2,
        callerSidecarName: "preview",
        reason: "max_depth_exceeded",
        sidecarName: "worker",
      }),
      event: "session.sidecar.start_rejected",
    });
  });

  it("POST /sessions/:id/sidecars/:name/start allows one nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-api-nested-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = await writeSidecarDepthRecorder(context, "record-api-sidecar.sh");
    const configPath = await context.writeConfig(
      "sidecar-api-nested.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
        autoStart: true
      preview:
        command: "${recorderPath}"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar api test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/preview/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callerSidecarDepth: 1, callerSidecarName: "dev" }),
    });

    const previewAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--preview`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(previewAlive).toBe(true);

    const nestedDepth = await pollUntil(
      async () =>
        (
          await readFile(
            sidecarDepthPath(spawned.worktreePath, spawned.id, "preview"),
            "utf8",
          ).catch(() => "")
        ).trim(),
      {
        timeoutMs: 10_000,
        accept: (value) => value === "2",
      },
    );
    expect(nestedDepth).toBe("2");
  });

  it("POST /sessions/:id/sidecars/:name/start rejects callers already inside a nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-api-reject-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "sidecar-api-reject.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
      preview:
        command: "tail -f /dev/null"
      worker:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar api reject test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await expect(
      context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/worker/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callerSidecarDepth: 2, callerSidecarName: "preview" }),
      }),
    ).rejects.toThrow("Sidecars can nest only one level deep");
    expect(await tmuxSessionExists(`${spawned.id}--worker`)).toBe(false);
  });

  it("spawn with autoStart: true creates the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-autostart-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-autostart.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server autostart test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${spawned.id}--dev`;
    const devSessionAlive = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (v) => v === true,
    });
    const sidecarEvents = readEventLog(context.dataDir)
      .map((e) => e.event)
      .filter((ev) => typeof ev === "string" && ev.startsWith("session.sidecar"));
    expect(sidecarEvents).toContain("session.sidecar.started");
    expect(devSessionAlive).toBe(true);
  });

  it("reserves sidecar ports per live session and releases them after cleanup", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-reserved-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = join(context.repoDir, "record-sidecar-port.sh");
    await writeFile(
      recorderPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_RESERVED_PORT_DEV:-}" > ".sidecar-port-\${SPUR_SESSION:?}"
tail -f /dev/null
`,
      "utf8",
    );
    await chmod(recorderPath, 0o755);
    const configPath = await context.writeConfig(
      "sidecar-reserved-ports.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      dev:
        command: "./record-sidecar-port.sh"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 4600
            end: 4601
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const first = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "first", "--json"])).stdout,
    ) as SessionView;
    const second = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "second", "--json"])).stdout,
    ) as SessionView;

    const firstPort = await pollUntil(
      async () =>
        readFile(join(context.repoDir, `.sidecar-port-${first.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    const secondPort = await pollUntil(
      async () =>
        readFile(join(context.repoDir, `.sidecar-port-${second.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );

    expect(new Set([firstPort.trim(), secondPort.trim()])).toEqual(new Set(["4600", "4601"]));

    await context.execCli(["--config", configPath, "kill", first.id, "--force", "--json"]);

    const third = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "third", "--json"])).stdout,
    ) as SessionView;
    const thirdPort = await pollUntil(
      async () =>
        readFile(join(context.repoDir, `.sidecar-port-${third.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    expect(thirdPort.trim()).toBe("4600");
  });

  it("keeps spawn running when no reserved sidecar ports remain and allows manual retry later", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-ports-full-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = join(context.repoDir, "record-sidecar-port.sh");
    await writeFile(
      recorderPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_RESERVED_PORT_DEV:-}" > ".sidecar-port-\${SPUR_SESSION:?}"
tail -f /dev/null
`,
      "utf8",
    );
    await chmod(recorderPath, 0o755);
    const configPath = await context.writeConfig(
      "sidecar-reserved-ports-full.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      dev:
        command: "./record-sidecar-port.sh"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 4700
            end: 4700
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const first = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "first", "--json"])).stdout,
    ) as SessionView;
    const second = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "second", "--json"])).stdout,
    ) as SessionView;

    await pollUntil(
      async () =>
        readFile(join(context.repoDir, `.sidecar-port-${first.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim() === "4700" },
    );
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toContain(
      "session.sidecar.autostart.failed",
    );

    await expect(
      context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
        method: "POST",
      }),
    ).rejects.toThrow("No free reserved port for sidecar dev.http in range 4700-4700");

    await context.execCli(["--config", configPath, "kill", first.id, "--force", "--json"]);
    await context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
      method: "POST",
    });
    const secondPort = await pollUntil(
      async () =>
        readFile(join(context.repoDir, `.sidecar-port-${second.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    expect(secondPort.trim()).toBe("4700");
  });

  it("kill cleans up the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-kill-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-kill.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "tail -f /dev/null"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server kill test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${spawned.id}--dev`;

    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (v) => v === true,
    });

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/kill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    const devSessionGone = !(await tmuxSessionExists(devSessionName));
    expect(devSessionGone).toBe(true);
  });

  it("pause cleans up the sidecar tmux session and keeps the workspace", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-pause-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = join(context.repoDir, "record-pause-sidecar-port.sh");
    await writeFile(
      recorderPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_RESERVED_PORT_DEV:-}" > ".sidecar-port-\${SPUR_SESSION:?}"
tail -f /dev/null
`,
      "utf8",
    );
    await chmod(recorderPath, 0o755);
    const configPath = await context.writeConfig(
      "sidecar-pause.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      dev:
        command: "${recorderPath}"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 4800
            end: 4800
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const first = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "sidecar pause test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${first.id}--dev`;

    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (v) => v === true,
    });

    const paused = JSON.parse(
      (await context.execCli(["--config", configPath, "pause", first.id, "--json"])).stdout,
    ) as SessionView;
    expect(paused.status).toBe("stopped");
    expect(paused.workspaceExists).toBe(true);

    const devSessionGone = !(await tmuxSessionExists(devSessionName));
    expect(devSessionGone).toBe(true);
    expect(existsSync(first.worktreePath)).toBe(true);

    const second = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "sidecar retry", "--json"]))
        .stdout,
    ) as SessionView;
    await context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
      method: "POST",
    });
    const secondPort = await pollUntil(
      async () =>
        readFile(join(second.worktreePath, `.sidecar-port-${second.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    expect(secondPort.trim()).toBe("4800");
  });
});
