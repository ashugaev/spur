import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeInfo, SessionView } from "../../src/types.js";
import { findFreePort, pollUntil, sleep } from "../helpers/common.js";
import {
  CLI_PATH,
  captureTmuxPane,
  createRuntimeTestContext,
  createTmuxSession,
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  sendKeysToTmux,
  syncTmuxEnvironment,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

const activeContexts: Array<{
  context: RuntimeTestContext;
  daemonPid?: number;
  sessionPrefix: string;
  controllerSessionName?: string;
}> = [];

function baseConfig(context: RuntimeTestContext, sessionPrefix: string): string {
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
`;
}

async function runRestoreScenario(args: {
  agent?: "claude" | "codex";
  configName: string;
}): Promise<{ context: RuntimeTestContext; restored: SessionView[]; spawned: SessionView; pane: string }> {
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
  activeContexts[activeContexts.length - 1]!.daemonPid = daemon.info.pid;

  const spawnArgs = ["--config", configPath, "spawn", "api", "restore runtime prompt"];
  if (args.agent) {
    spawnArgs.push("--agent", args.agent);
  }
  spawnArgs.push("--json");

  const spawned = JSON.parse((await context.execCli(spawnArgs)).stdout) as SessionView;
  const expectedResumeId =
    (args.agent ?? "claude") === "codex"
      ? `thread-${spawned.id}`
      : `fake-claude-${spawned.id}`;

  await context.execCli([
    "--config",
    configPath,
    "send",
    spawned.id,
    "exit-now",
    "--json",
  ]);

  const exited = await pollUntil(
    async () =>
      JSON.parse(
        (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
      ) as SessionView[],
    {
      timeoutMs: 15_000,
      accept: (value) => value[0]?.activity === "exited" && value[0]?.runtimeAlive === true,
    },
  );
  expect(exited[0]?.workspaceExists).toBe(true);

  const controllerSessionName = `${sessionPrefix}-ui`;
  activeContexts[activeContexts.length - 1]!.controllerSessionName = controllerSessionName;
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

  await pollUntil(
    async () => captureTmuxPane(controllerSessionName),
    {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    },
  );

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
      accept: (value) => value[0]?.activity !== "exited" && value[0]?.runtimeAlive === true,
    },
  );

  const pane = await pollUntil(
    async () => captureTmuxPane(spawned.id),
    {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes("This session was restored after the agent exited."),
    },
  );

  const log = await pollUntil(
    async () => context.readAgentLog(spawned.id),
    {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`startup:resume:${expectedResumeId}:`),
    },
  );

  expect(log).toContain(`startup:resume:${expectedResumeId}:`);
  expect(restored[0]?.runtimeAlive).toBe(true);
  expect(existsSync(restored[0]?.worktreePath ?? "")).toBe(true);
  expect(pane).toContain("Original task:");

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
      const current = activeContexts.pop()!;
      await stopDaemonByPid(current.daemonPid);
      if (current.controllerSessionName) {
        await killTmuxSession(current.controllerSessionName);
      }
      await killTmuxSessionsByPrefix(current.sessionPrefix);
      await current.context.cleanup();
    }
  });

  it("auto-starts the daemon for list --json and returns an empty array", async () => {
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

    const { stdout } = await context.execCli(["--config", configPath, "list", "--json"]);
    const sessions = JSON.parse(stdout) as SessionView[];
    const info = await context.fetchJson<RuntimeInfo>("/info");
    activeContexts[activeContexts.length - 1]!.daemonPid = info.pid;

    expect(sessions).toEqual([]);
    expect(info.host).toBe("127.0.0.1");
    expect(info.port).toBe(port);
  });

  it("surfaces spawn and send errors through the built CLI without leaving session state behind", async () => {
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
    activeContexts[activeContexts.length - 1]!.daemonPid = daemon.info.pid;

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

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed).toEqual([]);
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
    activeContexts[activeContexts.length - 1]!.daemonPid = daemon.info.pid;

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

    await pollUntil(
      async () => captureTmuxPane(spawned.id),
      {
        timeoutMs: 15_000,
        accept: (value) => value.includes("initial runtime prompt"),
      },
    );

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "follow up runtime prompt",
      "--json",
    ]);

    const paneAfterSend = await pollUntil(
      async () => captureTmuxPane(spawned.id),
      {
        timeoutMs: 15_000,
        accept: (value) => value.includes("follow up runtime prompt"),
      },
    );
    expect(paneAfterSend).toContain("initial runtime prompt");

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.runtimeAlive).toBe(true);
    expect(listed[0]?.workspaceExists).toBe(true);

    const controllerSessionName = `${sessionPrefix}-ui`;
    activeContexts[activeContexts.length - 1]!.controllerSessionName = controllerSessionName;
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

    await pollUntil(
      async () => captureTmuxPane(controllerSessionName),
      {
        timeoutMs: 15_000,
        accept: (value) => value.includes("Sessions"),
      },
    );

    await sendKeysToTmux(controllerSessionName, "k");
    await sleep(1_000);
    await sendKeysToTmux(controllerSessionName, "q");

    const killed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value[0]?.status === "killed" &&
          value[0]?.runtimeAlive === false &&
          value[0]?.workspaceExists === false,
      },
    );

    expect(killed[0]?.status).toBe("killed");
  });

  it("restores an exited session in place from the TTY list", async () => {
    const result = await runRestoreScenario({ configName: "restore.yaml" });
    expect(result.spawned.agent).toBe("claude");
  });

  it("restores a codex session through the native resume command", async () => {
    const result = await runRestoreScenario({ agent: "codex", configName: "restore-codex.yaml" });
    expect(result.spawned.agent).toBe("codex");
  });

  it("shows a restore error in the TTY list when native resume state is missing", async () => {
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
    const configPath = await context.writeConfig("restore-missing.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    activeContexts[activeContexts.length - 1]!.daemonPid = daemon.info.pid;

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

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "exit-now",
      "--json",
    ]);

    await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value[0]?.activity === "exited" && value[0]?.runtimeAlive === true,
      },
    );

    await rm(join(context.rootDir, ".claude"), { recursive: true, force: true });

    const controllerSessionName = `${sessionPrefix}-ui`;
    activeContexts[activeContexts.length - 1]!.controllerSessionName = controllerSessionName;
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

    await pollUntil(
      async () => captureTmuxPane(controllerSessionName),
      {
        timeoutMs: 15_000,
        accept: (value) => value.includes("Sessions"),
      },
    );

    await sendKeysToTmux(controllerSessionName, "r");

    const controllerPane = await pollUntil(
      async () => captureTmuxPane(controllerSessionName),
      {
        timeoutMs: 15_000,
        accept: (value) => value.includes("No native resume state found for claude session"),
      },
    );

    await sendKeysToTmux(controllerSessionName, "q");

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.activity).toBe("exited");
    expect(controllerPane).toContain(`No native resume state found for claude session ${spawned.id}`);
  });
});
