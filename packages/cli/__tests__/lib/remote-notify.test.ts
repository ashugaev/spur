import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig } from "@composio/ao-core";
import { notifyRemoteReady } from "../../src/lib/remote-notify.js";

const { mockCreate, mockNotifyWithActions } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockNotifyWithActions: vi.fn(),
}));

vi.mock("@composio/ao-plugin-notifier-telegram", () => ({
  default: {
    create: mockCreate,
  },
}));

function makeConfig(notifiers: Record<string, unknown>): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {},
    notifiers: notifiers as OrchestratorConfig["notifiers"],
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    dataDir: "/tmp/.ao-sessions",
    worktreeDir: "/tmp/.worktrees/ao",
  } as OrchestratorConfig;
}

describe("notifyRemoteReady", () => {
  beforeEach(() => {
    mockNotifyWithActions.mockReset();
    mockCreate.mockReset().mockReturnValue({
      notifyWithActions: mockNotifyWithActions,
    });
  });

  it("finds Telegram notifier by plugin name, not key", async () => {
    const config = makeConfig({
      alerts: {
        plugin: "telegram",
        botToken: "123:abc",
        chatId: "42",
      },
    });

    await notifyRemoteReady(config, "http://100.64.1.2:3000");

    expect(mockCreate).toHaveBeenCalledWith(config.notifiers["alerts"]);
    expect(mockNotifyWithActions).toHaveBeenCalledOnce();
    expect(mockNotifyWithActions).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.dashboard_ready",
        sessionId: "",
        projectId: "",
      }),
      [{ label: "Open Dashboard", url: "http://100.64.1.2:3000" }],
    );
  });

  it("no-ops when Telegram notifier is absent", async () => {
    const config = makeConfig({
      alerts: {
        plugin: "slack",
      },
    });

    await notifyRemoteReady(config, "http://localhost:3000");

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockNotifyWithActions).not.toHaveBeenCalled();
  });

  it("swallows notifier errors", async () => {
    const config = makeConfig({
      telegram_main: {
        plugin: "telegram",
        botToken: "123:abc",
        chatId: "42",
      },
    });

    mockCreate.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(notifyRemoteReady(config, "http://localhost:3000")).resolves.toBeUndefined();
  });
});
