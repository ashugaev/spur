import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { githubSourceModule } from "../../src/event-sources/github.js";
import { SessionService } from "../../src/session-service.js";
import type { SessionView } from "../../src/types.js";
import { findFreePort, pollUntil } from "../helpers/common.js";
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

function automationConfig(
  context: RuntimeTestContext,
  sessionPrefix: string,
  extraProjectYaml: string,
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

describe.skipIf(!tmuxOk)("Spur automation (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = activeContexts.pop()!;
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
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
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
          prompt: "cron runtime prompt"
`,
      ),
    );

    const daemon = await context.startDaemon(configPath);
    activeContexts[activeContexts.length - 1]!.daemonPid = daemon.info.pid;

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

    const pane = await pollUntil(
      async () => captureTmuxPane(sessions[0]!.id),
      {
        timeoutMs: 15_000,
        accept: (value) => value.includes("cron runtime prompt"),
      },
    );

    expect(sessions[0]?.project).toBe("api");
    expect(pane).toContain("cron runtime prompt");
  });

  it("emits GitHub comment events when the source snapshot changes", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-gh-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
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

    const originalEnv = {
      PATH: process.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: process.env.SPUR_FAKE_AGENT_LOG_DIR,
      SPUR_FAKE_GH_STATE_FILE: process.env.SPUR_FAKE_GH_STATE_FILE,
    };
    process.env.PATH = context.env.PATH;
    process.env.SPUR_FAKE_AGENT_LOG_DIR = context.agentLogDir;
    process.env.SPUR_FAKE_GH_STATE_FILE = context.ghStateFile;
    try {
      const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
      const session = await service.spawn({
        project: "api",
        agent: "claude",
        branch: "feature-runtime-gh",
        prompt: "initial github runtime prompt",
      });

      await pollUntil(
        async () => captureTmuxPane(session.id),
        {
          timeoutMs: 15_000,
          accept: (value) => value.includes("initial github runtime prompt"),
        },
      );

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
        await pollUntil(
          async () => existsSync(snapshotPath),
          {
            timeoutMs: 15_000,
            accept: Boolean,
          },
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

        const emittedEvent = await pollUntil(
          async () => events[0],
          {
            timeoutMs: 20_000,
            accept: (value) =>
              value?.name === "github:comment" &&
              Array.isArray((value.data as { signals?: unknown[] } | undefined)?.signals),
          },
        );

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
    } finally {
      process.env.PATH = originalEnv.PATH;
      process.env.SPUR_FAKE_AGENT_LOG_DIR = originalEnv.SPUR_FAKE_AGENT_LOG_DIR;
      process.env.SPUR_FAKE_GH_STATE_FILE = originalEnv.SPUR_FAKE_GH_STATE_FILE;
    }
  });
});
