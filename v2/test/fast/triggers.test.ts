import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";

const readGitHubSourceSnapshotMock = vi.fn();

vi.mock("../../src/metadata.js", () => ({
  readGitHubSourceSnapshot: readGitHubSourceSnapshotMock,
}));

function config(interrupt = false) {
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        triggers: {
          comment: {
            source: "pr-watch",
            event: "github:comment",
            send: { interrupt },
          },
        },
      },
    },
  };
}

function githubEvent(signalKey = "comment:1") {
  return {
    name: "github:comment",
    projectId: "api",
    sourceId: "pr-watch",
    data: {
      sessionId: "api-1",
      repo: "acme/api",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [
        {
          key: signalKey,
          kind: "comment",
          text: "A new comment arrived.",
        },
      ],
    },
  };
}

async function loadTriggersModule() {
  vi.resetModules();
  return import("../../src/triggers.js");
}

describe("startConfiguredTriggers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readGitHubSourceSnapshotMock.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers GitHub updates immediately when the target session is ready", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      activity: "ready",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config(false) as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: {
        warn: vi.fn(),
      },
    });

    try {
      bus.emit(githubEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledWith(
          "api-1",
          expect.stringContaining('GitHub updates on PR #42 "Tighten coverage":'),
          { interrupt: false },
        );
      });
    } finally {
      await controller.stop();
    }
  });

  it("queues updates while a session is busy and flushes them once it becomes ready", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        activity: "active",
        workspaceExists: true,
      })
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        activity: "ready",
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const warnMock = vi.fn();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config(false) as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: {
        warn: warnMock,
      },
    });

    try {
      bus.emit(githubEvent());
      await Promise.resolve();
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(deliverMock).toHaveBeenCalledOnce();
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: false },
      );
      expect(warnMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("does not repeatedly interrupt the same busy interval", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      activity: "active",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config(true) as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: {
        warn: vi.fn(),
      },
    });

    try {
      bus.emit(githubEvent("comment:1"));
      bus.emit(githubEvent("comment:2"));
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: true },
      );
    } finally {
      await controller.stop();
    }
  });
});
