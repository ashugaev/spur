import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import { loadConfig, loadProjectConfig } from "../../src/config.js";
import { EventBus } from "../../src/event-bus.js";
import { githubSourceModule } from "../../src/event-sources/github.js";
import { _resetGhPathCacheForTests } from "../../src/gh.js";
import { SessionService } from "../../src/session-service.js";
import { startConfiguredTriggers } from "../../src/triggers.js";
import type { SessionView } from "../../src/types.js";
import { execFileAsync, findFreePort, pollUntil, sleep } from "../helpers/common.js";
import {
  captureTmuxPane,
  createRuntimeTestContext,
  isTmuxAvailable,
  killTmuxSessionsByPrefix,
  syncTmuxEnvironment,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

const activeContexts: Array<{
  context: RuntimeTestContext;
  daemonPid?: number;
  sessionPrefix: string;
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

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function automationConfig(
  context: RuntimeTestContext,
  sessionPrefix: string,
  extraProjectYaml: string,
  extraRootYaml = "",
): string {
  return `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
${extraRootYaml}projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
${extraProjectYaml}
`;
}

function runtimeEnv(context: RuntimeTestContext) {
  return {
    HOME: context.env.HOME,
    PATH: context.env.PATH,
    SPUR_TMUX_SOCKET_NAME: context.env.SPUR_TMUX_SOCKET_NAME,
    SPUR_CLAUDE_BIN: context.env.SPUR_CLAUDE_BIN,
    SPUR_CODEX_BIN: context.env.SPUR_CODEX_BIN,
    SPUR_SKIP_CODEX_SUBMIT_ACK: context.env.SPUR_SKIP_CODEX_SUBMIT_ACK,
    SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
    SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    SPUR_IDLE_WAIT_BEFORE_FLUSH_MS: "0",
  };
}

async function syncAutomationTmuxEnvironment(context: RuntimeTestContext): Promise<void> {
  await syncTmuxEnvironment(runtimeEnv(context));
}

async function withRuntimeEnv<T>(context: RuntimeTestContext, run: () => Promise<T>): Promise<T> {
  const originalEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SPUR_TMUX_SOCKET_NAME: process.env.SPUR_TMUX_SOCKET_NAME,
    SPUR_CLAUDE_BIN: process.env.SPUR_CLAUDE_BIN,
    SPUR_CODEX_BIN: process.env.SPUR_CODEX_BIN,
    SPUR_SKIP_CODEX_SUBMIT_ACK: process.env.SPUR_SKIP_CODEX_SUBMIT_ACK,
    SPUR_FAKE_AGENT_LOG_DIR: process.env.SPUR_FAKE_AGENT_LOG_DIR,
    SPUR_FAKE_GH_STATE_FILE: process.env.SPUR_FAKE_GH_STATE_FILE,
    SPUR_IDLE_WAIT_BEFORE_FLUSH_MS: process.env.SPUR_IDLE_WAIT_BEFORE_FLUSH_MS,
  };
  _resetGhPathCacheForTests();
  Object.assign(process.env, runtimeEnv(context));
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    _resetGhPathCacheForTests();
  }
}

describe.skipIf(!tmuxOk)("Spur automation (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = popActiveContext();
      if (current.daemonPid) {
        try {
          process.kill(current.daemonPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      await killTmuxSessionsByPrefix(current.sessionPrefix);
      await current.context.cleanup();
    }
  });

  it("spawns a normal Spur session when a cron runOnStart trigger fires", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cron-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "cron.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      morning:
        type: cron
        schedule: "* * * * *"
        runOnStart: true
    triggers:
      morning-spawn:
        source: morning
        event: cron:tick
        spawn:
          prompt: "Review the repo"
          steps:
            - "research"
            - "test"
`,
      ),
    );

    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const sessions = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 20_000,
        accept: (value) => value.length === 1,
      },
    );
    const firstSession = sessions[0];
    if (!firstSession) {
      throw new Error("Expected GitHub automation test session");
    }

    const earlyPane = await pollUntil(async () => captureTmuxPane(firstSession.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/2: research]"),
    });

    expect(sessions[0]?.project).toBe("api");
    expect(earlyPane).toContain("Review the repo");
    expect(earlyPane).toContain("[Spur step 1/2: research]");

    await sleep(5_000);
    const beforeCooldownPane = await captureTmuxPane(firstSession.id);
    expect(beforeCooldownPane).not.toContain("[Spur step 2/2: test]");

    const pane = await pollUntil(async () => captureTmuxPane(firstSession.id), {
      timeoutMs: 45_000,
      accept: (value) => value.includes("[Spur step 2/2: test]"),
    });
    expect(pane).toContain("[Spur step 2/2: test]");
    const cronEvents = await pollUntil(
      async () => readEventLog(context.dataDir).map((entry) => entry.event),
      {
        timeoutMs: 20_000,
        accept: (value) =>
          value.includes("source.started") &&
          value.includes("source.run_on_start") &&
          value.includes("source.event.emitted") &&
          value.includes("trigger.spawn.matched") &&
          value.includes("trigger.spawn.completed") &&
          value.includes("session.spawn.completed") &&
          value.includes("session.pipeline.step_sent"),
      },
    );
    expect(cronEvents).toEqual(
      expect.arrayContaining([
        "source.started",
        "source.run_on_start",
        "source.event.emitted",
        "trigger.spawn.matched",
        "trigger.spawn.completed",
        "session.spawn.completed",
        "session.pipeline.step_sent",
      ]),
    );
  });

  it("applies trigger spawn overrides when automation starts a shared workspace session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cron-shared-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "cron-shared.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      morning:
        type: cron
        schedule: "* * * * *"
        runOnStart: true
    triggers:
      morning-spawn:
        source: morning
        event: cron:tick
        spawn:
          prompt: "cron shared prompt"
          overrides:
            worktree: false
`,
      ),
    );

    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const sessions = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 20_000,
        accept: (value) => value.length === 1 && value[0]?.worktree === false,
      },
    );
    const firstSession = sessions[0];
    if (!firstSession) {
      throw new Error("Expected shared automation session");
    }

    expect(firstSession.worktreePath).toBe(context.repoDir);
    await pollUntil(async () => captureTmuxPane(firstSession.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("cron shared prompt"),
    });
  });

  it("emits GitHub comment events when the source snapshot changes", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-gh-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "github.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
    triggers:
      pr-watch-comment:
        source: pr-watch
        event: github:comment
        send:
          interrupt: false
`,
      ),
    );

    await context.writeGhState({
      prsByBranch: {
        "feature-runtime-gh": {
          number: 42,
          title: "Tighten runtime coverage",
          url: "https://github.com/acme/api/pull/42",
          repo: "acme/api",
          reviewDecision: null,
        },
      },
    });

    await withRuntimeEnv(context, async () => {
      const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
      const session = await service.spawn({
        project: "api",
        agent: "claude",
        branch: "feature-runtime-gh",
        prompt: "initial github runtime prompt",
      });

      await pollUntil(async () => captureTmuxPane(session.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("initial github runtime prompt"),
      });

      const events: Array<{ name: string; data?: unknown }> = [];
      const abortController = new AbortController();
      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: context.dataDir,
        config: {
          type: "github",
          intervalMs: 1000,
          runOnStart: false,
          emitExisting: false,
        },
        emit(name, data) {
          events.push({ name, data });
        },
        signal: abortController.signal,
        logger: {
          warn: () => {},
        },
      });

      try {
        const snapshotPath = join(
          context.dataDir,
          "source-state",
          "github",
          "api",
          "pr-watch",
          `${session.id}.json`,
        );
        await pollUntil(async () => existsSync(snapshotPath), {
          timeoutMs: 15_000,
          accept: Boolean,
        });

        await context.writeGhState({
          prsByBranch: {
            "feature-runtime-gh": {
              number: 42,
              title: "Tighten runtime coverage",
              url: "https://github.com/acme/api/pull/42",
              repo: "acme/api",
              reviewDecision: null,
            },
          },
          commentsByPr: {
            "42": [
              {
                id: 1001,
                body: "Please rerun the focused runtime test.",
                html_url: "https://github.com/acme/api/pull/42#issuecomment-1001",
                user: {
                  login: "reviewer",
                },
              },
            ],
          },
        });

        const emittedEvent = await pollUntil(async () => events[0], {
          timeoutMs: 20_000,
          accept: (value) =>
            value?.name === "github:comment" &&
            Array.isArray((value.data as { signals?: unknown[] } | undefined)?.signals),
        });

        expect(emittedEvent?.name).toBe("github:comment");
        expect(emittedEvent?.data).toMatchObject({
          sessionId: session.id,
          prNumber: 42,
          signals: [
            expect.objectContaining({
              text: 'New PR comment from reviewer: "Please rerun the focused runtime test."',
            }),
          ],
        });
      } finally {
        abortController.abort();
        handle.stop();
      }
    });
  });

  it.each(["claude", "codex"] as const)(
    "delivers github:ci_failed to a live %s session through the trigger pipeline",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-gh-ci-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncAutomationTmuxEnvironment(context);
      const configPath = await context.writeConfig(
        `github-ci-${agent}.yaml`,
        automationConfig(
          context,
          sessionPrefix,
          `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
    triggers:
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: true
          prompt: "Run $manager and $github. Check failing CI on the active PR, fix it, rerun relevant checks, then push."
`,
        ),
      );

      await context.writeGhState({
        prsByBranch: {
          "feature-runtime-ci": {
            number: 42,
            title: "Keep CI green",
            url: "https://github.com/acme/api/pull/42",
            repo: "acme/api",
            reviewDecision: null,
          },
        },
      });

      await withRuntimeEnv(context, async () => {
        const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
        const session = await service.spawn({
          project: "api",
          agent,
          branch: "feature-runtime-ci",
          prompt: "initial github ci runtime prompt",
        });

        await pollUntil(async () => captureTmuxPane(session.id), {
          timeoutMs: 15_000,
          accept: (value) => value.includes("initial github ci runtime prompt"),
        });

        const config = loadProjectConfig(configPath, loadConfig(configPath));
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config,
          bus,
          sessionService: service,
          logger: {
            warn: () => {},
          },
        });
        const abortController = new AbortController();
        const handle = await githubSourceModule.start({
          sourceId: "pr-watch",
          projectId: "api",
          dataDir: context.dataDir,
          config: config.projects["api"]?.sources["pr-watch"] as never,
          emit(name, data) {
            bus.emit({
              name,
              projectId: "api",
              sourceId: "pr-watch",
              data,
            });
          },
          signal: abortController.signal,
          logger: {
            warn: () => {},
          },
        });

        try {
          await context.writeGhState({
            prsByBranch: {
              "feature-runtime-ci": {
                number: 42,
                title: "Keep CI green",
                url: "https://github.com/acme/api/pull/42",
                repo: "acme/api",
                reviewDecision: null,
              },
            },
            checksByPr: {
              "42": [
                {
                  name: "test suite",
                  state: "FAILURE",
                },
              ],
            },
          });

          const pane = await pollUntil(async () => captureTmuxPane(session.id), {
            timeoutMs: 20_000,
            accept: (value) => value.includes("CI is failing: test suite."),
          });
          const normalizedPane = pane.replaceAll(/\s+/g, " ");

          expect(pane).toContain('GitHub updates on PR #42 "Keep CI green":');
          expect(pane).toContain("CI is failing: test suite.");
          expect(normalizedPane).toContain(
            "Run $manager and $github. Check failing CI on the active PR",
          );
          expect(pane).not.toContain(
            "Inspect the failing checks, fix them, and rerun the relevant validation.",
          );
          const ciEvents = await pollUntil(
            async () => readEventLog(context.dataDir).map((entry) => entry.event),
            {
              timeoutMs: 20_000,
              accept: (value) =>
                value.includes("trigger.send.queued") &&
                value.includes("trigger.send.delivered") &&
                value.includes("session.message.sent"),
            },
          );
          expect(ciEvents).toEqual(
            expect.arrayContaining([
              "trigger.send.queued",
              "trigger.send.delivered",
              "session.message.sent",
            ]),
          );
          if (agent === "codex") {
            expect(ciEvents).not.toContain("session.submit.timeout");
          }
        } finally {
          abortController.abort();
          handle.stop();
          await controller.stop();
        }
      });
    },
  );

  it("wakes a fractionally stale session from a real GitHub source event", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-gh-stale-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "github-stale.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 250
        runOnStart: false
    triggers:
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: false
`,
        "staleAfterMinutes: 0.001\n",
      ),
    );
    await context.writeGhState({
      prsByBranch: {
        "feature-runtime-stale": {
          number: 42,
          title: "Wake stale runtime",
          url: "https://github.com/acme/api/pull/42",
          repo: "acme/api",
          reviewDecision: null,
        },
      },
    });

    await withRuntimeEnv(context, async () => {
      const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
      const session = await service.spawn({
        project: "api",
        agent: "claude",
        branch: "feature-runtime-stale",
        prompt: "initial stale runtime prompt",
      });
      await pollUntil(async () => captureTmuxPane(session.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("initial stale runtime prompt"),
      });

      const config = loadProjectConfig(configPath, loadConfig(configPath));
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config,
        bus,
        sessionService: service,
        logger: { warn: () => {} },
      });
      const abortController = new AbortController();
      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: context.dataDir,
        config: config.projects["api"]?.sources["pr-watch"] as never,
        emit(name, data) {
          bus.emit({ name, projectId: "api", sourceId: "pr-watch", data });
        },
        signal: abortController.signal,
        logger: { warn: () => {} },
      });

      try {
        const parked = await pollUntil(async () => service.get(session.id), {
          timeoutMs: 20_000,
          accept: (value) => value.status === "stopped" && value.state === "stale",
        });
        expect(parked.stopReason).toBe("stale_timeout");

        await context.writeGhState({
          prsByBranch: {
            "feature-runtime-stale": {
              number: 42,
              title: "Wake stale runtime",
              url: "https://github.com/acme/api/pull/42",
              repo: "acme/api",
              reviewDecision: null,
            },
          },
          checksByPr: { "42": [{ name: "stale runtime", state: "FAILURE" }] },
        });

        const pane = await pollUntil(async () => captureTmuxPane(session.id), {
          timeoutMs: 25_000,
          accept: (value) => value.includes("CI is failing: stale runtime."),
        });
        expect(pane).toContain("CI is failing: stale runtime.");
        const recovered = await service.get(session.id);
        expect(recovered.status).toBe("running");
        expect(recovered).not.toHaveProperty("stopReason");
        const lifecycleEvents = await pollUntil(
          async () => readEventLog(context.dataDir).map((entry) => entry.event),
          {
            timeoutMs: 10_000,
            accept: (events) =>
              events.includes("trigger.send.delivered") && events.includes("session.message.sent"),
          },
        );
        expect(lifecycleEvents).toEqual(
          expect.arrayContaining([
            "session.stale.parked",
            "trigger.send.queued",
            "trigger.send.delivered",
            "session.message.sent",
          ]),
        );
      } finally {
        abortController.abort();
        handle.stop();
        await controller.stop();
        service.dispose();
      }
    });
  });

  it("keeps github:ci_failed bound to the persisted PR after the worktree branch drifts", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-gh-ci-drift-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "github-ci-drift.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
    triggers:
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: true
          prompt: "Run $manager and $github. Check failing CI on the active PR, fix it, rerun relevant checks, then push."
`,
      ),
    );

    await context.writeGhState({
      prsByBranch: {
        "feature-runtime-ci": {
          number: 42,
          title: "Keep CI green",
          url: "https://github.com/acme/api/pull/42",
          repo: "acme/api",
          reviewDecision: null,
        },
      },
      prsByNumber: {
        "42": {
          number: 42,
          title: "Keep CI green",
          url: "https://github.com/acme/api/pull/42",
          repo: "acme/api",
          reviewDecision: null,
        },
      },
    });

    await withRuntimeEnv(context, async () => {
      const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
      const session = await service.spawn({
        project: "api",
        agent: "claude",
        branch: "feature-runtime-ci",
        prompt: "initial github ci runtime prompt",
      });

      await pollUntil(async () => captureTmuxPane(session.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("initial github ci runtime prompt"),
      });

      const config = loadProjectConfig(configPath, loadConfig(configPath));
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config,
        bus,
        sessionService: service,
        logger: {
          warn: () => {},
        },
      });
      const abortController = new AbortController();
      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: context.dataDir,
        config: config.projects["api"]?.sources["pr-watch"] as never,
        emit(name, data) {
          bus.emit({
            name,
            projectId: "api",
            sourceId: "pr-watch",
            data,
          });
        },
        signal: abortController.signal,
        logger: {
          warn: () => {},
        },
      });

      try {
        const sessionPath = join(context.dataDir, "sessions", "api", `${session.id}.json`);
        await pollUntil(
          async () =>
            JSON.parse(readFileSync(sessionPath, "utf-8")) as { pr?: { number?: number } },
          {
            timeoutMs: 20_000,
            accept: (value) => value.pr?.number === 42,
          },
        );

        await execFileAsync("git", ["-C", session.worktreePath, "switch", "-c", "feature-drifted"]);

        await context.writeGhState({
          prsByBranch: {},
          prsByNumber: {
            "42": {
              number: 42,
              title: "Keep CI green",
              url: "https://github.com/acme/api/pull/42",
              repo: "acme/api",
              reviewDecision: null,
            },
          },
          checksByPr: {
            "42": [
              {
                name: "test suite",
                state: "FAILURE",
              },
            ],
          },
        });

        const pane = await pollUntil(async () => captureTmuxPane(session.id), {
          timeoutMs: 20_000,
          accept: (value) => value.includes("CI is failing: test suite."),
        });

        expect(pane).toContain('GitHub updates on PR #42 "Keep CI green":');
        expect(pane).toContain("CI is failing: test suite.");
      } finally {
        abortController.abort();
        handle.stop();
        await controller.stop();
      }
    });
  });

  it("emits GitHub merge conflict events only when the conflict appears and reappears after clear", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-gh-conflict-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "github-conflict.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
    triggers: {}
`,
      ),
    );

    await context.writeGhState({
      prsByBranch: {
        "feature-runtime-conflict": {
          number: 42,
          title: "Resolve mergeability state",
          url: "https://github.com/acme/api/pull/42",
          repo: "acme/api",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        },
      },
    });

    await withRuntimeEnv(context, async () => {
      const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
      const session = await service.spawn({
        project: "api",
        agent: "claude",
        branch: "feature-runtime-conflict",
        prompt: "initial github merge-conflict runtime prompt",
      });

      await pollUntil(async () => captureTmuxPane(session.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("initial github merge-conflict runtime prompt"),
      });

      const events: Array<{ name: string; data?: unknown }> = [];
      const abortController = new AbortController();
      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: context.dataDir,
        config: {
          type: "github",
          intervalMs: 1000,
          runOnStart: false,
          emitExisting: false,
        },
        emit(name, data) {
          events.push({ name, data });
        },
        signal: abortController.signal,
        logger: {
          warn: () => {},
        },
      });

      try {
        const snapshotPath = join(
          context.dataDir,
          "source-state",
          "github",
          "api",
          "pr-watch",
          `${session.id}.json`,
        );
        await pollUntil(async () => existsSync(snapshotPath), {
          timeoutMs: 15_000,
          accept: Boolean,
        });

        await context.writeGhState({
          prsByBranch: {
            "feature-runtime-conflict": {
              number: 42,
              title: "Resolve mergeability state",
              url: "https://github.com/acme/api/pull/42",
              repo: "acme/api",
              reviewDecision: null,
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
            },
          },
        });

        const firstEvent = await pollUntil(async () => events[0], {
          timeoutMs: 20_000,
          accept: (value) =>
            value?.name === "github:merge_conflict" &&
            Array.isArray((value.data as { signals?: unknown[] } | undefined)?.signals),
        });
        expect(firstEvent?.data).toMatchObject({
          sessionId: session.id,
          prNumber: 42,
          signals: [
            expect.objectContaining({
              text: "Merge conflicts are blocking this PR.",
            }),
          ],
        });

        await context.writeGhState({
          prsByBranch: {
            "feature-runtime-conflict": {
              number: 42,
              title: "Resolve mergeability state",
              url: "https://github.com/acme/api/pull/42",
              repo: "acme/api",
              reviewDecision: null,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
            },
          },
        });
        await sleep(4_000);
        expect(events).toHaveLength(1);

        await context.writeGhState({
          prsByBranch: {
            "feature-runtime-conflict": {
              number: 42,
              title: "Resolve mergeability state",
              url: "https://github.com/acme/api/pull/42",
              repo: "acme/api",
              reviewDecision: null,
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
            },
          },
        });

        const secondEvent = await pollUntil(async () => events[1], {
          timeoutMs: 20_000,
          accept: (value) => value?.name === "github:merge_conflict",
        });
        expect(secondEvent?.data).toMatchObject({
          sessionId: session.id,
          prNumber: 42,
          signals: [
            expect.objectContaining({
              text: "Merge conflicts are blocking this PR.",
            }),
          ],
        });
      } finally {
        abortController.abort();
        handle.stop();
      }
    });
  });

  it.each(["claude", "codex"] as const)(
    "delivers github:merge_conflict to a live %s session through the trigger pipeline",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-gh-merge-conflict-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncAutomationTmuxEnvironment(context);
      const configPath = await context.writeConfig(
        `github-merge-conflict-${agent}.yaml`,
        automationConfig(
          context,
          sessionPrefix,
          `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
    triggers:
      pr-watch-merge-conflict:
        source: pr-watch
        event: github:merge_conflict
        send:
          interrupt: true
`,
        ),
      );

      await context.writeGhState({
        prsByBranch: {
          "feature-runtime-merge-conflict": {
            number: 42,
            title: "Keep branch mergeable",
            url: "https://github.com/acme/api/pull/42",
            repo: "acme/api",
            reviewDecision: null,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
        },
      });

      await withRuntimeEnv(context, async () => {
        const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
        const session = await service.spawn({
          project: "api",
          agent,
          branch: "feature-runtime-merge-conflict",
          prompt: "initial github merge conflict runtime prompt",
        });

        await pollUntil(async () => captureTmuxPane(session.id), {
          timeoutMs: 15_000,
          accept: (value) => value.includes("initial github merge conflict runtime prompt"),
        });

        const config = loadProjectConfig(configPath, loadConfig(configPath));
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config,
          bus,
          sessionService: service,
          logger: {
            warn: () => {},
          },
        });
        const abortController = new AbortController();
        const handle = await githubSourceModule.start({
          sourceId: "pr-watch",
          projectId: "api",
          dataDir: context.dataDir,
          config: config.projects["api"]?.sources["pr-watch"] as never,
          emit(name, data) {
            bus.emit({
              name,
              projectId: "api",
              sourceId: "pr-watch",
              data,
            });
          },
          signal: abortController.signal,
          logger: {
            warn: () => {},
          },
        });

        try {
          await context.writeGhState({
            prsByBranch: {
              "feature-runtime-merge-conflict": {
                number: 42,
                title: "Keep branch mergeable",
                url: "https://github.com/acme/api/pull/42",
                repo: "acme/api",
                reviewDecision: null,
                mergeable: "CONFLICTING",
                mergeStateStatus: "DIRTY",
              },
            },
          });

          const pane = await pollUntil(async () => captureTmuxPane(session.id), {
            timeoutMs: 20_000,
            accept: (value) => value.includes("Merge conflicts are blocking this PR."),
          });
          const normalizedPane = pane.replaceAll(/\s+/g, " ");

          expect(pane).toContain('GitHub updates on PR #42 "Keep branch mergeable":');
          expect(pane).toContain("Merge conflicts are blocking this PR.");
          expect(normalizedPane).toContain(
            "Resolve the active PR merge conflicts, rerun the relevant validation, and push.",
          );

          const conflictEvents = await pollUntil(
            async () => readEventLog(context.dataDir).map((entry) => entry.event),
            {
              timeoutMs: 20_000,
              accept: (value) =>
                value.includes("trigger.send.queued") &&
                value.includes("trigger.send.delivered") &&
                value.includes("session.message.sent"),
            },
          );
          expect(conflictEvents).toEqual(
            expect.arrayContaining([
              "trigger.send.queued",
              "trigger.send.delivered",
              "session.message.sent",
            ]),
          );
          if (agent === "codex") {
            expect(conflictEvents).not.toContain("session.submit.timeout");
          }
        } finally {
          abortController.abort();
          handle.stop();
          await controller.stop();
        }
      });
    },
  );

  it.each(["claude", "codex"] as const)(
    "re-delivers active github:merge_conflict after %s restore",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-gh-merge-conflict-restore-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncAutomationTmuxEnvironment(context);
      const configPath = await context.writeConfig(
        `github-merge-conflict-restore-${agent}.yaml`,
        automationConfig(
          context,
          sessionPrefix,
          `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
    triggers:
      pr-watch-merge-conflict:
        source: pr-watch
        event: github:merge_conflict
        send:
          interrupt: true
`,
        ),
      );

      await context.writeGhState({
        prsByBranch: {
          "feature-runtime-merge-conflict-restore": {
            number: 42,
            title: "Restore merge conflict alerts",
            url: "https://github.com/acme/api/pull/42",
            repo: "acme/api",
            reviewDecision: null,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
        },
      });

      await withRuntimeEnv(context, async () => {
        const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
        const session = await service.spawn({
          project: "api",
          agent,
          branch: "feature-runtime-merge-conflict-restore",
          prompt: "",
        });

        await pollUntil(async () => service.get(session.id), {
          timeoutMs: 15_000,
          accept: (value) => value.state === "waiting",
        });

        const config = loadProjectConfig(configPath, loadConfig(configPath));
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config,
          bus,
          sessionService: service,
          logger: {
            warn: () => {},
          },
        });
        const abortController = new AbortController();
        const handle = await githubSourceModule.start({
          sourceId: "pr-watch",
          projectId: "api",
          dataDir: context.dataDir,
          config: config.projects["api"]?.sources["pr-watch"] as never,
          emit(name, data) {
            bus.emit({
              name,
              projectId: "api",
              sourceId: "pr-watch",
              data,
            });
          },
          signal: abortController.signal,
          logger: {
            warn: () => {},
          },
        });

        try {
          const conflictMarker = 'GitHub updates on PR #42 "Restore merge conflict alerts":';
          await context.writeGhState({
            prsByBranch: {
              "feature-runtime-merge-conflict-restore": {
                number: 42,
                title: "Restore merge conflict alerts",
                url: "https://github.com/acme/api/pull/42",
                repo: "acme/api",
                reviewDecision: null,
                mergeable: "CONFLICTING",
                mergeStateStatus: "DIRTY",
              },
            },
          });

          await pollUntil(async () => captureTmuxPane(session.id), {
            timeoutMs: 20_000,
            accept: (value) => value.includes("Merge conflicts are blocking this PR."),
          });
          const agentLogBeforeRestore = await context.readAgentLog(session.id);
          expect(countOccurrences(agentLogBeforeRestore, conflictMarker)).toBe(1);

          await service.pause(session.id);

          await pollUntil(async () => service.get(session.id), {
            timeoutMs: 15_000,
            accept: (value) => value.state === "stopped",
          });

          const restored = await service.restore(session.id);
          expect(restored.status).toBe("running");

          const restoredLog = await pollUntil(async () => context.readAgentLog(session.id), {
            timeoutMs: 20_000,
            accept: (value) =>
              value.includes("startup:resume") &&
              countOccurrences(value, conflictMarker) === 2 &&
              value.lastIndexOf(conflictMarker) > value.lastIndexOf("startup:resume"),
          });
          expect(restoredLog).not.toContain("This session was restored after the agent exited.");
          expect(restoredLog).toContain("Merge conflicts are blocking this PR.");
        } finally {
          abortController.abort();
          handle.stop();
          await controller.stop();
        }
      });
    },
  );

  it("does not emit service problem alerts without tmux log scraping", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-alert-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncAutomationTmuxEnvironment(context);
    const configPath = await context.writeConfig(
      "service-alert.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      web-watch:
        type: service
        service: web
        intervalMs: 500
        tailLines: 50
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers:
      web-problem:
        source: web-watch
        event: service:crash
        send: {}
`,
      ),
    );

    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const session = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "watch the dev service",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", session.id, "spur");

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
        `'printf "SERVICE_BOOT\\nSERVICE_ERROR\\n"; sleep 1'`,
      ],
      {
        cwd: session.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: session.id,
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const events = readEventLog(context.dataDir).map((entry) => entry.event);
    expect(events).toContain("source.started");
    expect(events).not.toContain("source.event.emitted");
    expect(events).not.toContain("trigger.send.queued");
  });
});
