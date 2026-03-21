import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import type { RuntimeInfo, SessionView } from "../../src/types.js";
import { execFileAsync, findFreePort, pollUntil, sleep } from "../helpers/common.js";
import {
  CLI_PATH,
  captureTmuxPane,
  createRuntimeTestContext,
  createTmuxSession,
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  readTmuxOption,
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

  await context.execCli(["--config", configPath, "send", spawned.id, "exit-now", "--json"]);

  const exited = await pollUntil(
    async () =>
      JSON.parse(
        (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
      ) as SessionView[],
    {
      timeoutMs: 15_000,
      accept: (value) => value[0]?.state === "stopped" && value[0]?.runtimeAlive === true,
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
    accept: (value) => value.includes("This session was restored after the agent exited."),
  });

  const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
    timeoutMs: 15_000,
    accept: (value) => value.includes(`startup:resume:${expectedResumeId}:`),
  });

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

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed).toEqual([]);
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "daemon.started",
        "session.spawn.failed",
        "http.request.failed",
      ]),
    );
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
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value[0]?.status === "killed" &&
          value[0]?.runtimeAlive === false &&
          value[0]?.workspaceExists === true,
      },
    );

    expect(killed[0]?.worktree).toBe(false);
    expect(existsSync(context.repoDir)).toBe(true);
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
      "pr=https://github.com/org/repo/pull/9",
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

    expect(listed[0]?.slots).toEqual({
      title: "Investigate status bar links",
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-9" },
        { label: "pr", url: "https://github.com/org/repo/pull/9" },
      ],
    });
    expect(statusLeft).toContain("Investigate status bar links");
    expect(statusRight).toContain("tracker");
    expect(statusRight).toContain("pr");
    expect(statusRight).toContain(
      "#[hyperlink=https://tracker.example.com/TASK-9]tracker#[hyperlink=]",
    );
    expect(statusRight).toContain(
      "#[hyperlink=https://github.com/org/repo/pull/9]pr#[hyperlink=]",
    );
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toContain(
      "session.slots.updated",
    );
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
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "daemon.started",
        "session.spawn.completed",
        "session.message.sent",
        "session.kill.completed",
      ]),
    );

    await sendKeysToTmux(controllerSessionName, "Enter");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`Session ${spawned.id} was killed and cannot be restored.`),
    });

    await sendKeysToTmux(controllerSessionName, "r");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`Session ${spawned.id} cannot be restored.`),
    });

    await sendKeysToTmux(controllerSessionName, "q");
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

    await sendKeysToTmux(controllerSessionName, "C-b", "d");

    const detachedPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Enter attach"),
    });

    expect(detachedPane).toContain("Enter attach  r restore  k kill  Esc quit");
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

    const controllerPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("No native resume state found for claude session"),
    });

    await sendKeysToTmux(controllerSessionName, "q");

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.state).toBe("stopped");
    expect(controllerPane).toContain(
      `No native resume state found for claude session ${spawned.id}`,
    );
  });
});
