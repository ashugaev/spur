import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";

const readGitHubSourceSnapshotMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

vi.mock("../../src/metadata.js", () => ({
  readGitHubSourceSnapshot: readGitHubSourceSnapshotMock,
}));

function config(options?: { event?: string; interrupt?: boolean; prompt?: string }) {
  const event = options?.event ?? "github:comment";
  const interrupt = options?.interrupt ?? false;
  const prompt = options?.prompt;
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        sources: {
          "pr-watch": {
            type: "github",
          },
        },
        triggers: {
          send: {
            source: "pr-watch",
            event,
            send: {
              interrupt,
              ...(prompt !== undefined ? { prompt } : {}),
            },
          },
        },
      },
    },
  };
}

function spawnConfig() {
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        sources: {
          morning: {
            type: "cron",
          },
        },
        triggers: {
          kickoff: {
            source: "morning",
            event: "cron:tick",
            spawn: {
              prompt: "ship the task",
              steps: ["review", "continue"],
              overrides: {
                worktree: false,
              },
            },
          },
        },
      },
    },
  };
}

function workItemSpawnConfig() {
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        sources: {
          "pr-watch": {
            type: "github",
            query: "is:pr is:open",
          },
        },
        triggers: {
          "pick-up": {
            source: "pr-watch",
            event: "github:work_item.new",
            spawn: {
              prompt: "Take this work item.",
            },
          },
        },
      },
    },
  };
}

function serviceConfig(options?: { prompt?: string }) {
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        sources: {
          "web-watch": {
            type: "service",
          },
        },
        triggers: {
          notify: {
            source: "web-watch",
            event: "service:crash",
            send: {
              interrupt: false,
              ...(options?.prompt !== undefined ? { prompt: options.prompt } : {}),
            },
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

function ciFailedEvent() {
  return {
    name: "github:ci_failed",
    projectId: "api",
    sourceId: "pr-watch",
    data: {
      sessionId: "api-1",
      repo: "acme/api",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [
        {
          key: "ci_failed",
          kind: "ci_failed",
          text: "CI is failing: test suite.",
        },
      ],
    },
  };
}

function mergeConflictEvent() {
  return {
    name: "github:merge_conflict",
    projectId: "api",
    sourceId: "pr-watch",
    data: {
      sessionId: "api-1",
      repo: "acme/api",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [
        {
          key: "merge_conflict",
          kind: "merge_conflict",
          text: "Merge conflicts are blocking this PR.",
        },
      ],
    },
  };
}

function ciSnapshot() {
  return new Map([
    [
      "ci_failed",
      {
        key: "ci_failed",
        kind: "ci_failed",
        text: "CI is failing: test suite.",
      },
    ],
  ]);
}

function cronEvent() {
  return {
    name: "cron:tick",
    projectId: "api",
    sourceId: "morning",
    data: {},
  };
}

function serviceEvent(ruleId = "crash") {
  return {
    name: `service:${ruleId}`,
    projectId: "api",
    sourceId: "web-watch",
    data: {
      sessionId: "api-1",
      serviceId: "web",
      ruleId,
    },
  };
}

function staleActivity(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function recentActivity(): string {
  return new Date(Date.now() - 10_000).toISOString();
}

async function loadTriggersModule() {
  vi.resetModules();
  return import("../../src/triggers.js");
}

describe("startConfiguredTriggers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readGitHubSourceSnapshotMock.mockReset().mockReturnValue(null);
    logSpurEventMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers GitHub updates immediately when the target session is waiting", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
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
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining(
          "Review the latest GitHub updates on the active PR and act on them.",
        ),
        { interrupt: false },
      );
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.send.queued",
      );
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.send.delivered",
      );
    } finally {
      await controller.stop();
    }
  });

  it("uses custom send prompt when configured", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({
        prompt:
          "Run $manager and $github. Address the latest requested review changes on the active PR.",
      }) as never,
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
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });
      const delivered = deliverMock.mock.calls[0]?.[1];
      expect(typeof delivered).toBe("string");
      expect(delivered).toContain(
        "Run $manager and $github. Address the latest requested review changes on the active PR.",
      );
      expect(delivered).not.toContain(
        "Review the latest GitHub updates on the active PR and act on them.",
      );
    } finally {
      await controller.stop();
    }
  });

  it("adds built-in merge conflict guidance when no custom prompt is configured", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:merge_conflict" }) as never,
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
      bus.emit(mergeConflictEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("Merge conflicts are blocking this PR."),
        { interrupt: false },
      );
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining(
          "Resolve the active PR merge conflicts, rerun the relevant validation, and push.",
        ),
        { interrupt: false },
      );
    } finally {
      await controller.stop();
    }
  });

  it("retries ci_failed every 10 minutes up to three deliveries even while working when interrupt=true", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "working",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockImplementation(() => ciSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:ci_failed", interrupt: true }) as never,
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
      bus.emit(ciFailedEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });
      expect(deliverMock).toHaveBeenLastCalledWith(
        "api-1",
        expect.stringContaining("CI is failing: test suite."),
        { interrupt: true },
      );
      expect(deliverMock).toHaveBeenLastCalledWith(
        "api-1",
        expect.stringContaining(
          "Inspect the failing checks, fix them, and rerun the relevant validation.",
        ),
        { interrupt: true },
      );

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(deliverMock).toHaveBeenLastCalledWith(
        "api-1",
        expect.stringContaining("CI is failing: test suite."),
        { interrupt: true },
      );

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(3);
    } finally {
      await controller.stop();
    }
  });

  it("waits for the session to become waiting before sending ci_failed when interrupt=false", async () => {
    const working = {
      id: "api-1",
      status: "running",
      state: "working",
      workspaceExists: true,
    };
    const waiting = {
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    };
    const getMock = vi
      .fn()
      .mockResolvedValueOnce(working)
      .mockResolvedValueOnce(working)
      .mockResolvedValue(waiting);
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockImplementation(() => ciSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:ci_failed", interrupt: false }) as never,
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
      bus.emit(ciFailedEvent());
      await Promise.resolve();
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("CI is failing: test suite."),
        { interrupt: false },
      );
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining(
          "Review the latest GitHub updates on the active PR and act on them.",
        ),
        { interrupt: false },
      );
    } finally {
      await controller.stop();
    }
  });

  it("stops ci_failed retries once the failure disappears from the latest source snapshot", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    let snapshot = ciSnapshot();
    readGitHubSourceSnapshotMock.mockImplementation(() => snapshot);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:ci_failed", interrupt: false }) as never,
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
      bus.emit(ciFailedEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });

      snapshot = new Map();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.send.dropped",
      );
    } finally {
      await controller.stop();
    }
  });

  it("passes spawn overrides through to the session service", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-7" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnConfig() as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: vi.fn(),
      },
    });

    try {
      bus.emit(cronEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledWith({
          project: "api",
          prompt: "ship the task",
          steps: ["review", "continue"],
          overrides: {
            worktree: false,
          },
        });
      });
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.spawn.matched",
      );
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.spawn.completed",
      );
    } finally {
      await controller.stop();
    }
  });

  it("delivers service alerts with the list log-view hint for the bound session", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: serviceConfig() as never,
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
      bus.emit(serviceEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });
      const delivered = deliverMock.mock.calls[0]?.[1];
      expect(typeof delivered).toBe("string");
      expect(delivered).toContain('The bound service "web" has a problem.');
      expect(delivered).toContain("Triggered rules: crash");
      expect(delivered).toContain("select api-1 and press l");
    } finally {
      await controller.stop();
    }
  });

  it("queues updates while a session is busy and flushes them once it becomes waiting", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "working",
        workspaceExists: true,
      })
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const warnMock = vi.fn();
    readGitHubSourceSnapshotMock.mockReturnValue(
      new Map([
        [
          "comment:1",
          {
            key: "comment:1",
            kind: "comment",
            text: "A new comment arrived.",
          },
        ],
      ]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
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

  it("drops queued updates that disappeared from the latest source snapshot", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "working",
        workspaceExists: true,
      })
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(new Map());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
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
      await Promise.resolve();
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("does not repeatedly interrupt the same busy interval", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "working",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ interrupt: true }) as never,
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

  it("re-delivers an interrupting trigger after the session was restarted", async () => {
    vi.useRealTimers();
    const initial = {
      id: "api-1",
      status: "running" as const,
      state: "working" as const,
      workspaceExists: true,
    };
    const getMock = vi.fn().mockResolvedValue(initial);
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:merge_conflict", interrupt: true }) as never,
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
      bus.emit(mergeConflictEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });

      // Simulate a kill + restore: the session went through `stopped` and is
      // now back to `working` after restore. The state history records the
      // closed-state transition with a timestamp newer than the first
      // interrupt delivery.
      const restoredAt = new Date(Date.now() + 10).toISOString();
      const stoppedAt = new Date(Date.now() + 5).toISOString();
      getMock.mockResolvedValue({
        ...initial,
        state: "working",
        stateHistory: [
          { state: "working", at: new Date(Date.now() - 1000).toISOString(), source: "jsonl" },
          { state: "stopped", at: stoppedAt, source: "status" },
          { state: "working", at: restoredAt, source: "jsonl" },
        ],
      });

      bus.emit(mergeConflictEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(2);
      });
      expect(deliverMock.mock.calls[1]).toEqual([
        "api-1",
        expect.stringContaining("Merge conflicts are blocking this PR."),
        { interrupt: true },
      ]);
    } finally {
      await controller.stop();
      vi.useFakeTimers();
    }
  });

  it("retries delivery via flush loop when deliver throws", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "working",
      workspaceExists: true,
    });
    const deliverMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent busy"))
      .mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(
      new Map([
        [
          "merge_conflict",
          {
            key: "merge_conflict",
            kind: "merge_conflict",
            text: "Merge conflicts are blocking this PR.",
          },
        ],
      ]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:merge_conflict", interrupt: true }) as never,
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
      bus.emit(mergeConflictEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });
      expect(deliverMock).toHaveBeenNthCalledWith(
        1,
        "api-1",
        expect.stringContaining("Merge conflicts are blocking this PR."),
        { interrupt: true },
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(2);
      });
      expect(deliverMock).toHaveBeenNthCalledWith(
        2,
        "api-1",
        expect.stringContaining("Merge conflicts are blocking this PR."),
        { interrupt: true },
      );
    } finally {
      await controller.stop();
    }
  });

  it("seeds the pr slot link when a work-item event spawns a session", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit({
        name: "github:work_item.new",
        projectId: "api",
        sourceId: "pr-watch",
        data: {
          externalId: "acme/api#42",
          url: "https://github.com/acme/api/pull/42",
          number: 42,
          title: "Fix the bug",
          repo: "acme/api",
        },
      });
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1);
      });
      expect(spawnMock).toHaveBeenCalledWith({
        project: "api",
        prompt: "Take this work item.",
        slots: { links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }] },
      });
    } finally {
      await controller.stop();
    }
  });

  it("holds delivery in handleSendEvent fast path while the agent was active in the last 30s", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: recentActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(githubEvent());
      await Promise.resolve();
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("delivers via flushPending after lastActivityAt ages past 30s", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: recentActivity(),
        workspaceExists: true,
      })
      .mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(
      new Map([
        [
          "comment:1",
          {
            key: "comment:1",
            kind: "comment",
            text: "A new comment arrived.",
          },
        ],
      ]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(githubEvent());
      await Promise.resolve();
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: false },
      );
    } finally {
      await controller.stop();
    }
  });
});
