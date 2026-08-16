import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import { githubSourceModule } from "../../src/event-sources/github.js";
import { readWorkItemLifecycles } from "../../src/metadata.js";
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

function runtimeEnv(context: RuntimeTestContext) {
  return {
    HOME: context.env.HOME,
    PATH: context.env.PATH,
    SPUR_TMUX_SOCKET_NAME: context.env.SPUR_TMUX_SOCKET_NAME,
    SPUR_CLAUDE_BIN: context.env.SPUR_CLAUDE_BIN,
    SPUR_CODEX_BIN: context.env.SPUR_CODEX_BIN,
    SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
    SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
  };
}

// Seed the work-item registry so the polled repo already has a seen entry. This
// exercises the emit path: the repo-scoped suppression only silences repos that
// have no prior seen entries (fresh backlog), so an existing entry lets genuinely
// new PRs emit normally.
async function seedWorkItemRegistry(
  dataDir: string,
  projectId: string,
  sourceId: string,
  ids: string[],
): Promise<void> {
  const path = join(dataDir, "source-state", "github-work-items", projectId, `${sourceId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ids: [...ids].sort() }, null, 2)}\n`, "utf8");
}

describe.skipIf(!tmuxOk)("github work-item runtime flow", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = activeContexts.pop();
      if (!current) break;
      if (current.daemonPid) {
        try {
          process.kill(current.daemonPid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      await killTmuxSessionsByPrefix(current.sessionPrefix, current.context.tmuxSocketName);
      await current.context.cleanup();
    }
  });

  it("emits once per externalId and survives daemon restarts", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-wi-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment(runtimeEnv(context));

    await context.writeGhState({
      searchPrs: [
        {
          number: 11,
          title: "Refactor module",
          url: "https://github.com/acme/api/pull/11",
          repository: { nameWithOwner: "acme/api" },
        },
        {
          number: 12,
          title: "Tighten types",
          url: "https://github.com/acme/api/pull/12",
          repository: { nameWithOwner: "acme/api" },
        },
      ],
    });
    await seedWorkItemRegistry(context.dataDir, "api", "pr-watch", ["acme/api#1"]);

    const configPath = await context.writeConfig(
      "work-items.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: true
        query: "repo:acme/api"
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "Take this work item."
`,
      ),
    );

    const daemon = await context.startDaemon(configPath);
    const slot = activeContexts[activeContexts.length - 1];
    if (slot) slot.daemonPid = daemon.info.pid;

    const sessions = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 30_000,
        accept: (value) => value.length === 2,
      },
    );

    const urls = sessions
      .map((session) => session.slots?.links?.find((link) => link.label === "pr")?.url)
      .filter((value): value is string => typeof value === "string")
      .sort();
    expect(urls).toEqual([
      "https://github.com/acme/api/pull/11",
      "https://github.com/acme/api/pull/12",
    ]);

    // Second poll on the same fixture: no new sessions.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const after = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(after.length).toBe(2);

    // Stop daemon, restart with same dataDir, same gh fixture: still no new sessions.
    await context.stopDaemon(daemon.child);
    const slotAfterStop = activeContexts[activeContexts.length - 1];
    if (slotAfterStop) delete slotAfterStop.daemonPid;

    const daemon2 = await context.startDaemon(configPath);
    const slotAfterRestart = activeContexts[activeContexts.length - 1];
    if (slotAfterRestart) slotAfterRestart.daemonPid = daemon2.info.pid;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const afterRestart = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(afterRestart.length).toBe(2);

    const events = readEventLog(context.dataDir).map((entry) => entry.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "source.event.emitted",
        "trigger.spawn.matched",
        "trigger.spawn.completed",
      ]),
    );
  });

  it("spawns a PR review agent and records auto-complete lifecycle state", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-wi-auto-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment(runtimeEnv(context));

    await context.writeGhState({
      prsByNumber: {
        "42": {
          number: 42,
          title: "Review target",
          url: "https://github.com/acme/api/pull/42",
          repo: "acme/api",
          reviewDecision: null,
          state: "OPEN",
          closed: false,
        },
      },
      searchPrs: [
        {
          number: 42,
          title: "Review target",
          url: "https://github.com/acme/api/pull/42",
          repository: { nameWithOwner: "acme/api" },
        },
      ],
    });
    await seedWorkItemRegistry(context.dataDir, "api", "pr-watch", ["acme/api#1"]);

    const configPath = await context.writeConfig(
      "work-items-auto-complete.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: true
        query: "repo:acme/api"
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          agent: claude
          prompt: "/code-review {{url}}"
          autoComplete: true
`,
      ),
    );

    const daemon = await context.startDaemon(configPath);
    const slot = activeContexts[activeContexts.length - 1];
    if (slot) slot.daemonPid = daemon.info.pid;

    const [session] = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 30_000,
        accept: (value) => value.length === 1,
      },
    );
    if (!session) {
      throw new Error("expected spawned work-item session");
    }
    const sessionView = session;
    expect(sessionView.agent).toBe("claude");
    expect(sessionView.slots?.links).toContainEqual({
      label: "pr",
      url: "https://github.com/acme/api/pull/42",
    });

    await pollUntil(() => context.readAgentLog(sessionView.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("/code-review https://github.com/acme/api/pull/42"),
    });

    const lifecycle = await pollUntil(
      async () => readWorkItemLifecycles(context.dataDir, "api", "pr-watch").get("acme/api#42"),
      {
        timeoutMs: 15_000,
        accept: (value) => value?.state === "running" && value.sessionId === sessionView.id,
      },
    );
    expect(lifecycle).toEqual(
      expect.objectContaining({
        externalId: "acme/api#42",
        state: "running",
        sessionId: sessionView.id,
        url: "https://github.com/acme/api/pull/42",
        number: 42,
        title: "Review target",
        repo: "acme/api",
      }),
    );

    const events = readEventLog(context.dataDir).map((entry) => entry.event);
    expect(events).toEqual(
      expect.arrayContaining(["source.event.emitted", "trigger.spawn.completed"]),
    );
  });

  it("keeps emitting per-branch ci_failed signals when query is also set", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-wi-coexist-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment(runtimeEnv(context));

    const configPath = await context.writeConfig(
      "work-items-coexist.yaml",
      automationConfig(
        context,
        sessionPrefix,
        `    sources:
      pr-watch:
        type: github
        intervalMs: 1000
        runOnStart: false
        query: "repo:acme/api"
`,
      ),
    );

    await context.writeGhState({
      prsByBranch: {
        "feature-coexist": {
          number: 99,
          title: "Coexist test",
          url: "https://github.com/acme/api/pull/99",
          repo: "acme/api",
          reviewDecision: null,
        },
      },
      searchPrs: [
        {
          number: 100,
          title: "From query",
          url: "https://github.com/acme/api/pull/100",
          repository: { nameWithOwner: "acme/api" },
        },
      ],
    });

    const originalEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SPUR_TMUX_SOCKET_NAME: process.env.SPUR_TMUX_SOCKET_NAME,
      SPUR_CLAUDE_BIN: process.env.SPUR_CLAUDE_BIN,
      SPUR_CODEX_BIN: process.env.SPUR_CODEX_BIN,
      SPUR_FAKE_AGENT_LOG_DIR: process.env.SPUR_FAKE_AGENT_LOG_DIR,
      SPUR_FAKE_GH_STATE_FILE: process.env.SPUR_FAKE_GH_STATE_FILE,
    };
    Object.assign(process.env, runtimeEnv(context));
    try {
      const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
      const session = await service.spawn({
        project: "api",
        agent: "claude",
        branch: "feature-coexist",
        prompt: "coexist runtime prompt",
      });

      await pollUntil(async () => captureTmuxPane(session.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("coexist runtime prompt"),
      });

      await seedWorkItemRegistry(context.dataDir, "api", "pr-watch", ["acme/api#1"]);

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
          query: "repo:acme/api",
        },
        emit(name, data) {
          events.push({ name, data });
        },
        signal: abortController.signal,
        logger: { warn: () => {} },
      });

      try {
        // Wait for the work-item emit and first per-branch snapshot.
        await pollUntil(async () => events.some((event) => event.name === "github:work_item.new"), {
          timeoutMs: 15_000,
          accept: Boolean,
        });

        // Now introduce a failing check so the next poll diff emits ci_failed.
        await context.writeGhState({
          prsByBranch: {
            "feature-coexist": {
              number: 99,
              title: "Coexist test",
              url: "https://github.com/acme/api/pull/99",
              repo: "acme/api",
              reviewDecision: null,
            },
          },
          checksByPr: {
            "99": [{ name: "test suite", state: "FAILURE" }],
          },
          searchPrs: [
            {
              number: 100,
              title: "From query",
              url: "https://github.com/acme/api/pull/100",
              repository: { nameWithOwner: "acme/api" },
            },
          ],
        });

        await pollUntil(async () => events.some((event) => event.name === "github:ci_failed"), {
          timeoutMs: 20_000,
          accept: Boolean,
        });
        expect(events.map((event) => event.name)).toEqual(
          expect.arrayContaining(["github:ci_failed", "github:work_item.new"]),
        );
      } finally {
        abortController.abort();
        handle.stop();
      }
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
