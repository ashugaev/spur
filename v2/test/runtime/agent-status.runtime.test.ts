import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionView } from "../../src/types.js";
import { findFreePort, pollUntil } from "../helpers/common.js";
import {
  createRuntimeTestContext,
  isTmuxAvailable,
  killTmuxSessionsByPrefix,
  syncTmuxEnvironment,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

interface ActiveContext {
  context: RuntimeTestContext;
  daemonPid?: number;
  sessionPrefix: string;
}

const activeContexts: ActiveContext[] = [];

function baseConfig(context: RuntimeTestContext, sessionPrefix: string): string {
  return `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  test:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
`;
}

async function getSession(port: number, sessionId: string): Promise<SessionView> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}`);
  return (await response.json()) as SessionView;
}

async function waitForState(
  port: number,
  sessionId: string,
  expectedState: string,
  timeoutMs = 30_000,
): Promise<SessionView> {
  return pollUntil(() => getSession(port, sessionId), {
    timeoutMs,
    accept: (s) => s.state === expectedState,
  });
}

describe.skipIf(!tmuxOk)("Agent status detection (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = activeContexts.pop();
      if (!current) {
        throw new Error("expected active runtime context during cleanup");
      }
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

  async function setup(label: string) {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-status-${label}-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      `status-${label}.yaml`,
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    const current = activeContexts[activeContexts.length - 1];
    if (!current) {
      throw new Error("expected active runtime context after setup");
    }
    current.daemonPid = daemon.info.pid;
    return { context, configPath, port };
  }

  async function spawnSession(
    context: RuntimeTestContext,
    configPath: string,
    agent: "claude" | "codex" | "cursor",
    prompt = "status test",
  ): Promise<SessionView> {
    const args = ["--config", configPath, "spawn", "test", prompt, "--agent", agent, "--json"];
    return JSON.parse((await context.execCli(args)).stdout) as SessionView;
  }

  // ── Claude JSONL-based state detection ─────────────────────────────────

  it("Claude: spawn reaches waiting state from JSONL end_turn", async () => {
    const { context, configPath, port } = await setup("claude-wait");
    const session = await spawnSession(context, configPath, "claude");

    const view = await waitForState(port, session.id, "waiting");
    expect(view.state).toBe("waiting");
    expect(view.status).toBe("running");
  });

  it("Claude: AskUserQuestion JSONL produces needs_input", async () => {
    const { context, configPath, port } = await setup("claude-needs");
    const session = await spawnSession(context, configPath, "claude");
    await waitForState(port, session.id, "waiting");

    // show-waiting-menu makes fake agent write AskUserQuestion JSONL metadata.
    await context.execCli(["--config", configPath, "send", session.id, "show-waiting-menu"]);

    const view = await waitForState(port, session.id, "needs_input");
    expect(view.state).toBe("needs_input");
  });

  it("Claude: slow tool_result stays working until the tool completes", async () => {
    const { context, configPath, port } = await setup("claude-slow-tool");
    const session = await spawnSession(context, configPath, "claude");
    await waitForState(port, session.id, "waiting");

    await context.execCli(["--config", configPath, "send", session.id, "slow-tool-result"]);

    const view = await waitForState(port, session.id, "waiting");
    const states = view.stateHistory?.map((entry) => entry.state) ?? [];
    expect(states).not.toContain("needs_input");
  });

  it("Claude: pause → stopped, resume → waiting, kill → killed", async () => {
    const { context, configPath, port } = await setup("claude-lifecycle");
    const session = await spawnSession(context, configPath, "claude");
    await waitForState(port, session.id, "waiting");

    // Pause
    await context.execCli(["--config", configPath, "pause", session.id, "--json"]);
    const s1 = await waitForState(port, session.id, "stopped");
    expect(s1.state).toBe("stopped");
    expect(s1.status).toBe("stopped");

    // Resume by sending a message
    await context.execCli(["--config", configPath, "send", session.id, "hello"]);
    const s2 = await waitForState(port, session.id, "waiting");
    expect(s2.state).toBe("waiting");

    // Kill
    await context.execCli(["--config", configPath, "kill", session.id, "--json"]);
    const s3 = await waitForState(port, session.id, "killed");
    expect(s3.state).toBe("killed");
    expect(s3.status).toBe("killed");
  });

  it("Claude: complete → stopped", async () => {
    const { context, configPath, port } = await setup("claude-cpl");
    const session = await spawnSession(context, configPath, "claude");
    await waitForState(port, session.id, "waiting");

    await context.execCli(["--config", configPath, "complete", session.id, "--json"]);
    const view = await waitForState(port, session.id, "stopped");
    expect(view.state).toBe("stopped");
    expect(view.status).toBe("completed");
  });

  it("Claude: agent exit → stopped", async () => {
    const { context, configPath, port } = await setup("claude-exit");
    const session = await spawnSession(context, configPath, "claude");
    await waitForState(port, session.id, "waiting");

    await context.execCli(["--config", configPath, "send", session.id, "exit-now"]);
    const view = await waitForState(port, session.id, "stopped");
    expect(view.state).toBe("stopped");
    expect(view.status).toBe("stopped");
  });

  it("Claude: state history records transitions", async () => {
    const { context, configPath, port } = await setup("claude-hist");
    const session = await spawnSession(context, configPath, "claude");

    // Wait for waiting, then trigger needs_input via show-waiting-menu
    await waitForState(port, session.id, "waiting");
    await context.execCli(["--config", configPath, "send", session.id, "show-waiting-menu"]);
    const view = await waitForState(port, session.id, "needs_input");

    expect(view.stateHistory).toBeDefined();
    const stateHistory = view.stateHistory;
    if (!stateHistory) {
      throw new Error("expected state history to be present");
    }
    expect(stateHistory.length).toBeGreaterThanOrEqual(2);
    const states = stateHistory.map((t) => t.state);
    expect(states).toContain("waiting");
    expect(states).toContain("needs_input");
  });

  // ── Codex hook/jsonl-based state detection ─────────────────────────────
  // Codex defaults to hook state, falls back to structured rollout JSONL,
  // and still uses the same STATE_HOLD_MS (4s) debounce rules.

  it("Codex: spawn reaches waiting state from Stop hook", async () => {
    const { context, configPath, port } = await setup("codex-wait");
    const session = await spawnSession(context, configPath, "codex");

    const view = await waitForState(port, session.id, "waiting", 45_000);
    expect(view.state).toBe("waiting");
    expect(view.status).toBe("running");
  });

  it("Codex: show-waiting-menu produces needs_input from structured hook/jsonl state", async () => {
    const { context, configPath, port } = await setup("codex-needs");
    const session = await spawnSession(context, configPath, "codex");
    await waitForState(port, session.id, "waiting", 45_000);

    await context.execCli(["--config", configPath, "send", session.id, "show-waiting-menu"]);

    const view = await waitForState(port, session.id, "needs_input", 45_000);
    expect(view.state).toBe("needs_input");
  });

  it("Codex: spawn trusts the worktree path in the session-local config", async () => {
    const { context, configPath } = await setup("codex-trust");
    const session = await spawnSession(context, configPath, "codex");
    const worktreePath = session.worktreePath;
    if (!worktreePath) {
      throw new Error("expected spawned Codex session to have a worktree path");
    }
    const configPathname = join(
      context.dataDir,
      "session-tools",
      session.id,
      "codex-home",
      "config.toml",
    );
    const trustBlock = `[projects.${JSON.stringify(worktreePath)}]\ntrust_level = "trusted"`;

    const content = await pollUntil(async () => readFile(configPathname, "utf8").catch(() => ""), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(trustBlock),
    });

    expect(content).toContain("suppress_unstable_features_warning = true");
    expect(content).toContain(trustBlock);
  });

  it("Codex: pause → stopped, resume → waiting, kill → killed", async () => {
    const { context, configPath, port } = await setup("codex-lifecycle");
    const session = await spawnSession(context, configPath, "codex");
    await waitForState(port, session.id, "waiting", 45_000);

    // Pause
    await context.execCli(["--config", configPath, "pause", session.id, "--json"]);
    const s1 = await waitForState(port, session.id, "stopped");
    expect(s1.state).toBe("stopped");
    expect(s1.status).toBe("stopped");

    // Resume by sending a message
    await context.execCli(["--config", configPath, "send", session.id, "hello"]);
    const s2 = await waitForState(port, session.id, "waiting", 45_000);
    expect(s2.state).toBe("waiting");

    // Kill
    await context.execCli(["--config", configPath, "kill", session.id, "--json"]);
    const s3 = await waitForState(port, session.id, "killed");
    expect(s3.state).toBe("killed");
    expect(s3.status).toBe("killed");
  });

  it("Codex: complete → stopped", async () => {
    const { context, configPath, port } = await setup("codex-cpl");
    const session = await spawnSession(context, configPath, "codex");
    await waitForState(port, session.id, "waiting", 45_000);

    await context.execCli(["--config", configPath, "complete", session.id, "--json"]);
    const view = await waitForState(port, session.id, "stopped");
    expect(view.state).toBe("stopped");
    expect(view.status).toBe("completed");
  });

  it("Codex: agent exit → stopped", async () => {
    const { context, configPath, port } = await setup("codex-exit");
    const session = await spawnSession(context, configPath, "codex");
    await waitForState(port, session.id, "waiting", 45_000);

    await context.execCli(["--config", configPath, "send", session.id, "exit-now"]);
    const view = await waitForState(port, session.id, "stopped");
    expect(view.state).toBe("stopped");
    expect(view.status).toBe("stopped");
  });

  // ── Cursor pane/activity-based state detection ────────────────────────

  it("Cursor: spawn settles to waiting once the pane goes idle", async () => {
    const { context, configPath, port } = await setup("cursor-wait");
    const session = await spawnSession(context, configPath, "cursor");

    const view = await waitForState(port, session.id, "waiting", 45_000);
    expect(view.state).toBe("waiting");
    expect(view.status).toBe("running");
  });

  it("Cursor: trust prompt markers produce needs_input", async () => {
    const { context, configPath, port } = await setup("cursor-needs");
    const session = await spawnSession(context, configPath, "cursor");

    await context.execCli(["--config", configPath, "send", session.id, "show-waiting-menu"]);

    const view = await waitForState(port, session.id, "needs_input", 30_000);
    expect(view.state).toBe("needs_input");
  });

  it("Cursor: pause → stopped, resume → waiting, kill → killed", async () => {
    const { context, configPath, port } = await setup("cursor-lifecycle");
    const session = await spawnSession(context, configPath, "cursor");

    await context.execCli(["--config", configPath, "pause", session.id, "--json"]);
    const s1 = await waitForState(port, session.id, "stopped");
    expect(s1.state).toBe("stopped");
    expect(s1.status).toBe("stopped");

    await context.execCli(["--config", configPath, "send", session.id, "hello"]);
    const s2 = await waitForState(port, session.id, "waiting", 45_000);
    expect(s2.state).toBe("waiting");

    await context.execCli(["--config", configPath, "kill", session.id, "--json"]);
    const s3 = await waitForState(port, session.id, "killed");
    expect(s3.state).toBe("killed");
    expect(s3.status).toBe("killed");
  });

  it("Cursor: complete → stopped", async () => {
    const { context, configPath, port } = await setup("cursor-cpl");
    const session = await spawnSession(context, configPath, "cursor");

    await context.execCli(["--config", configPath, "complete", session.id, "--json"]);
    const view = await waitForState(port, session.id, "stopped");
    expect(view.state).toBe("stopped");
    expect(view.status).toBe("completed");
  });

  it("Cursor: agent exit → stopped", async () => {
    const { context, configPath, port } = await setup("cursor-exit");
    const session = await spawnSession(context, configPath, "cursor");

    await context.execCli(["--config", configPath, "send", session.id, "exit-now"]);
    const view = await waitForState(port, session.id, "stopped");
    expect(view.state).toBe("stopped");
  });
});
