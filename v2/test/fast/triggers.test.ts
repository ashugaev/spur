import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as eventLogModule from "../../src/event-log.js";
import { EventBus } from "../../src/event-bus.js";
import type {
  PersistedPendingBatch,
  ReviewSignal,
  ReviewSnapshot,
  WorkItemLifecycleRecord,
} from "../../src/types.js";

// Builds the on-disk/in-memory envelope shape `readGitHubSourceSnapshotMock`
// now returns. `prNumber` defaults to 42 to match the fixture events' `prNumber`
// below so the mocked snapshot is treated as the current PR's state.
function storedSnapshot(signals: ReviewSignal[], prNumber: number | null = 42): ReviewSnapshot {
  return { prNumber, signals: new Map(signals.map((signal) => [signal.key, signal])) };
}

const readGitHubSourceSnapshotMock = vi.fn();
const readReviewSourceSnapshotMock = vi.fn();
const readWorkItemLifecyclesMock = vi.fn();
const recordWorkItemLifecycleMock = vi.fn();
const deleteWorkItemLifecycleMock = vi.fn();
const readPendingSendBatchesMock = vi.fn();
const recordPendingSendBatchMock = vi.fn();
const deletePendingSendBatchMock = vi.fn();
const logSpurEventMock = vi.fn();
const DATA_DIR = `/tmp/spur-trigger-data-${process.pid}`;

function inputLogEntries(sessionId: string): unknown[] {
  return logSpurEventMock.mock.calls
    .map(([, entry]) => entry)
    .filter((entry) => entry.event === "session.input.received" && entry.sessionId === sessionId);
}

vi.mock("../../src/event-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof eventLogModule>();
  return {
    ...actual,
    logSpurEvent: logSpurEventMock,
    logUserInputEvent: (dataDir: string, input: Parameters<typeof actual.logUserInputEvent>[1]) => {
      const entry = actual.buildUserInputLogEntry(input);
      if (entry) logSpurEventMock(dataDir, entry);
    },
  };
});

vi.mock("../../src/metadata.js", () => ({
  deleteWorkItemLifecycle: deleteWorkItemLifecycleMock,
  readGitHubSourceSnapshot: readGitHubSourceSnapshotMock,
  readReviewSourceSnapshot: readReviewSourceSnapshotMock,
  readWorkItemLifecycles: readWorkItemLifecyclesMock,
  recordWorkItemLifecycle: recordWorkItemLifecycleMock,
  readPendingSendBatches: readPendingSendBatchesMock,
  recordPendingSendBatch: recordPendingSendBatchMock,
  deletePendingSendBatch: deletePendingSendBatchMock,
}));

function config(options?: { event?: string; interrupt?: boolean; prompt?: string }) {
  const event = options?.event ?? "github:comment";
  const interrupt = options?.interrupt ?? false;
  const prompt = options?.prompt;
  return {
    dataDir: DATA_DIR,
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

function gitlabConfig() {
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        sources: {
          "mr-watch": {
            type: "gitlab",
          },
        },
        triggers: {
          send: {
            source: "mr-watch",
            event: "gitlab:comment",
            send: {
              interrupt: false,
            },
          },
        },
      },
    },
  };
}

function spawnConfig() {
  return {
    dataDir: DATA_DIR,
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
              blocks: [
                {
                  prompt: "ship the task",
                  steps: ["review", "continue"],
                  overrides: {
                    worktree: false,
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function spawnModelConfig() {
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
              blocks: [
                {
                  prompt: "ship the task",
                  agent: "codex",
                  model: "gpt-5.5",
                },
              ],
            },
          },
        },
      },
    },
  };
}

function spawnModeConfig() {
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
              blocks: [
                {
                  prompt: "ship the task",
                  mode: "council",
                },
              ],
            },
          },
        },
      },
    },
  };
}

function spawnFanoutConfig() {
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
              blocks: [
                {
                  prompt: "ship {{task}}",
                  steps: ["review", "continue"],
                  agent: "claude",
                  overrides: {
                    worktree: false,
                  },
                },
                {
                  prompt: "risks for {{task}}",
                  steps: ["verify"],
                  agent: "codex",
                  overrides: {
                    worktree: false,
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function spawnDeskGroupConfig() {
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
            spawnDeskGroup: true,
            spawn: {
              blocks: [
                {
                  prompt: "ship {{task}}",
                  steps: ["review", "continue"],
                  agent: "claude",
                  overrides: {
                    worktree: false,
                  },
                },
                {
                  prompt: "risks for {{task}}",
                  steps: ["verify"],
                  agent: "codex",
                  overrides: {
                    worktree: false,
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function workItemSpawnConfig(options?: { prompt?: string; autoComplete?: boolean }) {
  return {
    dataDir: DATA_DIR,
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
              blocks: [
                {
                  prompt: options?.prompt ?? "Take {{url}} from {{repo}}.",
                },
              ],
              autoComplete: options?.autoComplete ?? true,
            },
          },
        },
      },
    },
  };
}

function workItemFanoutSpawnConfig() {
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
              blocks: [
                {
                  agent: "claude",
                  prompt: "Claude review {{url}}.",
                },
                {
                  agent: "codex",
                  prompt: "Codex review {{url}}.",
                },
              ],
            },
          },
        },
      },
    },
  };
}

function workItemReadOnlyFanoutSpawnConfig() {
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
              restrictWrites: true,
              allowedTriggers: [],
              blocks: [
                {
                  agent: "claude",
                  model: "sonnet",
                  prompt: "Claude review {{url}}.",
                },
                {
                  agent: "cursor",
                  model: "composer-2.5",
                  prompt: "Cursor review {{url}}.",
                },
              ],
            },
          },
        },
      },
    },
  };
}

function sentrySpawnConfig(options?: { prompt?: string; autoComplete?: boolean }) {
  return {
    dataDir: "/tmp/spur-data",
    projects: {
      api: {
        sources: {
          "sentry-issues": {
            type: "sentry",
            authToken: "token",
            org: "acme",
            project: "web",
            baseUrl: "https://sentry.io",
            query: "is:unresolved",
            intervalMs: 60_000,
            emitExisting: false,
          },
        },
        triggers: {
          triage: {
            source: "sentry-issues",
            event: "sentry:issue.new",
            spawn: {
              blocks: [
                {
                  prompt: options?.prompt ?? "Triage {{url}} from {{repo}}.",
                },
              ],
              autoComplete: options?.autoComplete ?? true,
            },
          },
        },
      },
    },
  };
}

function sentryEvent() {
  return {
    name: "sentry:issue.new",
    projectId: "api",
    sourceId: "sentry-issues",
    data: {
      externalId: "acme/web#WEB-7",
      url: "https://sentry.io/issues/7/",
      number: 7,
      title: "Boom",
      repo: "acme/web",
    },
  };
}

function serviceConfig(options?: { prompt?: string }) {
  return {
    dataDir: DATA_DIR,
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

function commentSnapshot(signalKey = "comment:1"): ReviewSnapshot {
  return storedSnapshot([{ key: signalKey, kind: "comment", text: "A new comment arrived." }]);
}

function gitlabEvent(signalKey = "comment:1") {
  return {
    name: "gitlab:comment",
    projectId: "api",
    sourceId: "mr-watch",
    data: {
      sessionId: "api-1",
      repo: "acme/api",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [
        {
          key: signalKey,
          kind: "comment",
          text: "A new GitLab comment arrived.",
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

function mergeConflictSignal(): ReviewSignal {
  return {
    key: "merge_conflict",
    kind: "merge_conflict",
    text: "Merge conflicts are blocking this PR.",
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
      signals: [mergeConflictSignal()],
    },
  };
}

function ciSnapshot(): ReviewSnapshot {
  return storedSnapshot([
    {
      key: "ci_failed",
      kind: "ci_failed",
      text: "CI is failing: test suite.",
    },
  ]);
}

function mergeConflictSnapshot(): ReviewSnapshot {
  return storedSnapshot([mergeConflictSignal()]);
}

function cronEvent() {
  return {
    name: "cron:tick",
    projectId: "api",
    sourceId: "morning",
    data: {},
  };
}

function fanoutCronEvent() {
  return {
    name: "cron:tick",
    projectId: "api",
    sourceId: "morning",
    data: {
      task: "ship the task",
    },
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

function workItemEvent() {
  return {
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
  };
}

function runningWorkItemLifecycle(
  options?: Partial<Extract<WorkItemLifecycleRecord, { state: "running" }>>,
): Extract<WorkItemLifecycleRecord, { state: "running" }> {
  return {
    externalId: "acme/api#42",
    sessionId: "api-9",
    url: "https://github.com/acme/api/pull/42",
    number: 42,
    title: "Fix the bug",
    repo: "acme/api",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    autoComplete: true,
    state: "running",
    ...options,
  };
}

function useWorkItemLifecycleStore(initial?: WorkItemLifecycleRecord[]) {
  const records = new Map<string, WorkItemLifecycleRecord>();
  for (const record of initial ?? []) {
    records.set(record.externalId, record);
  }
  readWorkItemLifecyclesMock.mockImplementation(() => new Map(records));
  recordWorkItemLifecycleMock.mockImplementation(
    (_dataDir: string, _projectId: string, _sourceId: string, record: WorkItemLifecycleRecord) => {
      records.set(record.externalId, record);
    },
  );
  deleteWorkItemLifecycleMock.mockImplementation(
    (_dataDir: string, _projectId: string, _sourceId: string, externalId: string) => {
      records.delete(externalId);
    },
  );
  return records;
}

async function loadTriggersModule() {
  vi.resetModules();
  return import("../../src/triggers.js");
}

async function advanceSendWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(35_000);
}

describe("startConfiguredTriggers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readGitHubSourceSnapshotMock.mockReset().mockReturnValue(null);
    readReviewSourceSnapshotMock.mockReset().mockReturnValue(null);
    readWorkItemLifecyclesMock.mockReset().mockReturnValue(new Map());
    recordWorkItemLifecycleMock.mockReset();
    deleteWorkItemLifecycleMock.mockReset();
    readPendingSendBatchesMock.mockReset().mockReturnValue(new Map());
    recordPendingSendBatchMock.mockReset();
    deletePendingSendBatchMock.mockReset();
    logSpurEventMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers GitHub updates via flush loop when the target session is waiting", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining('GitHub updates on PR #42 "Tighten coverage":'),
        { interrupt: false },
      );
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
      expect(inputLogEntries("api-1")).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it("retains the first-arrival deadline when a second event merges into the same queue key", async () => {
    const secondEvent = {
      name: "github:comment",
      projectId: "api",
      sourceId: "pr-watch",
      data: {
        sessionId: "api-1",
        repo: "acme/api",
        prNumber: 42,
        prTitle: "Tighten coverage",
        signals: [{ key: "comment:2", kind: "comment", text: "A follow-up comment." }],
      },
    };
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(
      storedSnapshot([
        { key: "comment:1", kind: "comment", text: "A new comment arrived." },
        { key: "comment:2", kind: "comment", text: "A follow-up comment." },
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
      bus.emit(githubEvent("comment:1"));
      // Advance to ~25s; second event arrives before the 30s window expires.
      await vi.advanceTimersByTimeAsync(25_000);
      bus.emit(secondEvent);
      expect(deliverMock).not.toHaveBeenCalled();

      // The original deadline is ~30s from t0 (not extended by the merge).
      // Advance 5s more (total 30s from first event) — window expires, delivery fires.
      await vi.advanceTimersByTimeAsync(5_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: false },
      );
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A follow-up comment."),
        { interrupt: false },
      );
    } finally {
      await controller.stop();
    }
  });

  it("delivers on first flush tick when SPUR_IDLE_WAIT_BEFORE_FLUSH_MS is 0", async () => {
    process.env["SPUR_IDLE_WAIT_BEFORE_FLUSH_MS"] = "0";
    try {
      const getMock = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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
    } finally {
      delete process.env["SPUR_IDLE_WAIT_BEFORE_FLUSH_MS"];
    }
  });

  it("delivers GitLab updates via flush loop when the target session is waiting", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readReviewSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: gitlabConfig() as never,
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
      bus.emit(gitlabEvent());
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining('GitLab updates on merge request #42 "Tighten coverage":'),
        { interrupt: false },
      );
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("Review the latest GitLab updates on the active merge request"),
        { interrupt: false },
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
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({
        prompt:
          "  Run $manager and $github. Address the latest requested review changes on the active PR.  ",
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);
      const delivered = deliverMock.mock.calls[0]?.[1];
      expect(typeof delivered).toBe("string");
      expect(delivered).toContain(
        "Run $manager and $github. Address the latest requested review changes on the active PR.",
      );
      expect(delivered).not.toContain(
        "Review the latest GitHub updates on the active PR and act on them.",
      );
      expect(inputLogEntries("api-1")).toEqual([
        expect.objectContaining({
          event: "session.input.received",
          message:
            "Run $manager and $github. Address the latest requested review changes on the active PR.",
          projectId: "api",
          sourceId: "pr-watch",
          triggerId: "send",
          details: expect.objectContaining({
            inputKind: "trigger_send_prompt",
            source: "trigger",
            text: "Run $manager and $github. Address the latest requested review changes on the active PR.",
            eventName: "github:comment",
          }),
        }),
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("does not record an empty custom send prompt", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ prompt: "   " }) as never,
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(inputLogEntries("api-1")).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it("does not record custom send prompts dropped for closed sessions", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "stopped",
      state: "stopped",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ prompt: "Read the active PR feedback and fix it." }) as never,
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
        expect(getMock).toHaveBeenCalledTimes(1);
      });
      expect(deliverMock).not.toHaveBeenCalled();
      expect(inputLogEntries("api-1")).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it("does not record custom send prompts pruned before delivery", async () => {
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
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot([]));
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ prompt: "Read the active PR feedback and fix it." }) as never,
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
      expect(inputLogEntries("api-1")).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it("records a custom send prompt once for merged trigger events", async () => {
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
        state: "working",
        workspaceExists: true,
      })
      .mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ prompt: "Read the active PR feedback and fix it." }) as never,
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
      bus.emit(githubEvent());
      await vi.waitFor(() => {
        expect(getMock).toHaveBeenCalledTimes(2);
      });

      await advanceSendWindow();

      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(inputLogEntries("api-1")).toEqual([
        expect.objectContaining({
          event: "session.input.received",
          message: "Read the active PR feedback and fix it.",
          details: expect.objectContaining({
            inputKind: "trigger_send_prompt",
            source: "trigger",
            text: "Read the active PR feedback and fix it.",
          }),
        }),
      ]);
    } finally {
      await controller.stop();
    }
  });

  it("does not duplicate custom send prompt records on delivery retry", async () => {
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
      config: config({
        event: "github:ci_failed",
        interrupt: true,
        prompt: "Read the failing CI report and fix it.",
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
      bus.emit(ciFailedEvent());
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(deliverMock).toHaveBeenCalledTimes(3);
      expect(inputLogEntries("api-1")).toEqual([
        expect.objectContaining({
          event: "session.input.received",
          message: "Read the failing CI report and fix it.",
          details: expect.objectContaining({
            inputKind: "trigger_send_prompt",
            source: "trigger",
            text: "Read the failing CI report and fix it.",
          }),
        }),
      ]);
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
    readGitHubSourceSnapshotMock.mockReturnValue(mergeConflictSnapshot());
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);
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

  it("does not deliver a ci_failed retry batch with interrupt=true while the session is rate_limited", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "rate_limited",
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
      await Promise.resolve();
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).not.toHaveBeenCalled();
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

      await advanceSendWindow();
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

  it("does not deliver or consume retry attempts for ci_failed with interrupt=true while needs_input, then delivers interrupt:false after window once waiting", async () => {
    const needsInput = {
      id: "api-1",
      status: "running",
      state: "needs_input",
      workspaceExists: true,
    };
    const waiting = {
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    };
    const getMock = vi.fn().mockResolvedValue(needsInput);
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
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(ciFailedEvent());
      // needs_input: no delivery even across multiple flush ticks.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(deliverMock).not.toHaveBeenCalled();

      // Switch to waiting before the 30s window expires. Still no delivery.
      getMock.mockResolvedValue(waiting);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(deliverMock).not.toHaveBeenCalled();

      // Window expires: delivers with interrupt:false (not interrupt:true).
      await vi.advanceTimersByTimeAsync(6_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("CI is failing: test suite."),
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);

      snapshot = storedSnapshot([]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.send.dropped",
      );
    } finally {
      await controller.stop();
    }
  });

  it("backs off and drops a delivery that keeps failing instead of retrying forever", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockRejectedValue(new Error("submit-ack timeout"));
    readGitHubSourceSnapshotMock.mockImplementation(() => commentSnapshot());
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
      await vi.advanceTimersByTimeAsync(30_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // Flush ticks inside the first backoff window (10s) must not re-attempt.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // Exponential backoff from a 10s base, doubling between the 8 attempts.
      const backoffsMs = [10, 20, 40, 80, 160, 320, 640].map((seconds) => seconds * 1_000);
      let expectedCalls = 1;
      for (const backoff of backoffsMs) {
        await vi.advanceTimersByTimeAsync(backoff);
        expectedCalls += 1;
        expect(deliverMock).toHaveBeenCalledTimes(expectedCalls);
      }
      expect(deliverMock).toHaveBeenCalledTimes(8);

      // Eighth failure exhausts the cap: drop the batch, log it, and stop.
      const dropped = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .find((entry) => entry.event === "trigger.send.dropped");
      expect(dropped).toBeDefined();
      expect(dropped.details).toMatchObject({ reason: "retry_exhausted", attempts: 8 });

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(8);
    } finally {
      await controller.stop();
    }
  });

  it("clears delivery-failure backoff once a later attempt succeeds", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("submit-ack timeout"))
      .mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockImplementation(() => commentSnapshot());
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.dropped",
      );

      // Successful delivery clears the batch; the flush loop stops.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
    } finally {
      await controller.stop();
    }
  });

  it("clears delivery-failure backoff when the session restarted after the failure", async () => {
    const session = {
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    };
    const getMock = vi.fn().mockResolvedValue(session);
    const deliverMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("session torn down"))
      .mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockImplementation(() => commentSnapshot());
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
      // t=30000: window opens, flush delivers and fails.
      // recordedAt≈30000, nextAttemptAt≈40000 (10s backoff window).
      bus.emit(githubEvent());
      await vi.advanceTimersByTimeAsync(30_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // Session restarted: stopped entry after the failure at t≈30000.
      getMock.mockResolvedValue({
        ...session,
        stateHistory: [
          { state: "stopped", at: new Date(Date.now()).toISOString(), source: "status" as const },
        ],
      });

      // t=35000: strictly inside 10s backoff window (nextAttemptAt=40000).
      // clearBackoffIfRestarted detects the stopped transition → clears → delivers.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
    } finally {
      await controller.stop();
    }
  });

  it("does not clear delivery-failure backoff without a session restart", async () => {
    const session = {
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    };
    const getMock = vi.fn().mockResolvedValue(session);
    const deliverMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient error"))
      .mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockImplementation(() => commentSnapshot());
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
      // t=30000: first delivery fails; recordedAt≈30000, nextAttemptAt≈40000.
      bus.emit(githubEvent());
      await vi.advanceTimersByTimeAsync(30_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // t=35000: no restart in stateHistory → backoff holds.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // t=40000: backoff expires naturally → retry proceeds.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
    } finally {
      await controller.stop();
    }
  });

  it("clears delivery-failure backoff at handleSendEvent when interrupt session restarted, delivering immediately", async () => {
    const session = {
      id: "api-1",
      status: "running" as const,
      state: "working" as const,
      workspaceExists: true,
    };
    const getMock = vi.fn().mockResolvedValue(session);
    const deliverMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("pane write failed"))
      .mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockImplementation(() => mergeConflictSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ event: "github:merge_conflict", interrupt: true }) as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: { warn: vi.fn() },
    });

    try {
      // First event: handleSendEvent fires interrupt delivery immediately (working).
      // Delivery throws → recordedAt≈0, nextAttemptAt≈10000.
      bus.emit(mergeConflictEvent());
      await vi.advanceTimersByTimeAsync(1);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock.mock.calls[0]).toEqual([
        "api-1",
        expect.stringContaining("Merge conflicts are blocking this PR."),
        { interrupt: true },
      ]);

      // t=5000: flush fires; session has no restart history → clearBackoffIfRestarted
      // is a no-op → backoff holds → skip. (Also validates flushPending call-site
      // does NOT clear without restart evidence.)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // Session restarted: stopped entry after the failure at t≈0.
      getMock.mockResolvedValue({
        ...session,
        stateHistory: [
          { state: "stopped", at: new Date(Date.now()).toISOString(), source: "status" as const },
        ],
      });

      // Second event before natural backoff expiry (t<10000).
      // handleSendEvent: clearBackoffIfRestarted detects stopped → clears →
      // proceeds past isInDeliveryBackoff → delivers with interrupt:true.
      bus.emit(mergeConflictEvent());
      await vi.advanceTimersByTimeAsync(1);
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(deliverMock.mock.calls[1]).toEqual([
        "api-1",
        expect.stringContaining("Merge conflicts are blocking this PR."),
        { interrupt: true },
      ]);
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

  it("threads block model into the spawn call", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-7" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnModelConfig() as never,
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
          agent: "codex",
          model: "gpt-5.5",
        });
      });
    } finally {
      await controller.stop();
    }
  });

  it("threads block mode into the spawn call", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-7" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnModeConfig() as never,
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
          mode: "council",
        });
      });
    } finally {
      await controller.stop();
    }
  });

  it("spawns each trigger block in order with its own prompt, steps, and agent", async () => {
    const spawnMock = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-7" })
      .mockResolvedValueOnce({ id: "api-8" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnFanoutConfig() as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: vi.fn(),
      },
    });

    try {
      bus.emit(fanoutCronEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(spawnMock).toHaveBeenNthCalledWith(1, {
        project: "api",
        prompt: "ship ship the task",
        steps: ["review", "continue"],
        agent: "claude",
        overrides: {
          worktree: false,
        },
      });
      expect(spawnMock).toHaveBeenNthCalledWith(2, {
        project: "api",
        prompt: "risks for ship the task",
        steps: ["verify"],
        agent: "codex",
        overrides: {
          worktree: false,
        },
      });
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.spawn.completed",
      );
    } finally {
      await controller.stop();
    }
  });

  it("uses the first desk-group block as workspace anchor for later blocks", async () => {
    const spawnMock = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-7" })
      .mockResolvedValueOnce({ id: "api-8" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnDeskGroupConfig() as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: vi.fn(),
      },
    });

    try {
      bus.emit(fanoutCronEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(spawnMock).toHaveBeenNthCalledWith(1, {
        project: "api",
        prompt: "ship ship the task",
        steps: ["review", "continue"],
        agent: "claude",
        overrides: {
          worktree: false,
        },
      });
      expect(spawnMock).toHaveBeenNthCalledWith(2, {
        project: "api",
        prompt: "risks for ship the task",
        steps: ["verify"],
        agent: "codex",
        overrides: {
          worktree: false,
        },
        reuseWorkspaceSessionId: "api-7",
      });
    } finally {
      await controller.stop();
    }
  });

  it("blocks desk-group children when anchor spawn fails", async () => {
    const spawnMock = vi.fn().mockRejectedValueOnce(new Error("anchor failed"));
    const warnMock = vi.fn();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnDeskGroupConfig() as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: warnMock,
      },
    });

    try {
      bus.emit(fanoutCronEvent());
      await vi.waitFor(() => {
        expect(warnMock).toHaveBeenCalledWith(
          "[trigger:api/kickoff] failed to spawn claude: anchor failed",
        );
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stop();
    }
  });

  it("logs desk-group child failures and continues remaining children", async () => {
    const spawnMock = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-7" })
      .mockRejectedValueOnce(new Error("child failed"));
    const warnMock = vi.fn();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnDeskGroupConfig() as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: warnMock,
      },
    });

    try {
      bus.emit(fanoutCronEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(warnMock).toHaveBeenCalledWith(
        "[trigger:api/kickoff] failed to spawn codex: child failed",
      );
    } finally {
      await controller.stop();
    }
  });

  it("logs fan-out spawn failures and continues remaining targets", async () => {
    const spawnMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("claude failed"))
      .mockResolvedValueOnce({ id: "api-8" });
    const warnMock = vi.fn();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnFanoutConfig() as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: warnMock,
      },
    });

    try {
      bus.emit(fanoutCronEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(spawnMock.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          agent: "codex",
          prompt: "risks for ship the task",
        }),
      );
      expect(warnMock).toHaveBeenCalledWith(
        "[trigger:api/kickoff] failed to spawn claude: claude failed",
      );
      expect(logSpurEventMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        expect.objectContaining({
          event: "trigger.spawn.failed",
          details: {
            eventName: "cron:tick",
            agent: "claude",
          },
        }),
      );
      expect(logSpurEventMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        expect.objectContaining({
          event: "trigger.spawn.completed",
          sessionId: "api-8",
          details: {
            eventName: "cron:tick",
            agent: "codex",
          },
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("logs fan-out render failures and continues remaining targets", async () => {
    const config = spawnFanoutConfig();
    const firstBlock = config.projects.api.triggers.kickoff.spawn.blocks[0];
    if (!firstBlock) {
      throw new Error("missing first spawn block");
    }
    firstBlock.prompt = "ship {{missing}}";
    const spawnMock = vi.fn().mockResolvedValueOnce({ id: "api-8" });
    const warnMock = vi.fn();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config as never,
      bus,
      sessionService: {
        spawn: spawnMock,
      } as never,
      logger: {
        warn: warnMock,
      },
    });

    try {
      bus.emit(fanoutCronEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1);
      });
      expect(spawnMock).toHaveBeenCalledWith({
        project: "api",
        prompt: "risks for ship the task",
        steps: ["verify"],
        agent: "codex",
        overrides: {
          worktree: false,
        },
      });
      expect(warnMock).toHaveBeenCalledWith(
        "[trigger:api/kickoff] failed to spawn claude: Cannot render prompt placeholder {{missing}}: event data.missing is unavailable",
      );
      expect(logSpurEventMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        expect.objectContaining({
          event: "trigger.spawn.failed",
          details: {
            eventName: "cron:tick",
            agent: "claude",
          },
        }),
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);
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
      .mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const warnMock = vi.fn();
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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

      await advanceSendWindow();

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

  it("does not deliver a send trigger while the session is rate_limited", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "rate_limited",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const warnMock = vi.fn();
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
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.dropped",
      );
    } finally {
      await controller.stop();
    }
  });

  it("delivers a previously-queued send trigger once the session leaves rate_limited", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "rate_limited",
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
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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

      await advanceSendWindow();

      expect(deliverMock).toHaveBeenCalledOnce();
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: false },
      );
    } finally {
      await controller.stop();
    }
  });

  it("does not drop a send trigger as closed_session while the session is a live server-error wedge", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "error",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const warnMock = vi.fn();
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
      expect(deliverMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.dropped",
      );
    } finally {
      await controller.stop();
    }
  });

  it("drops a send trigger as closed_session for a genuinely closed errored session (status !== running)", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "errored",
      state: "error",
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    const warnMock = vi.fn();
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
      await vi.waitFor(() => {
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
          "trigger.send.dropped",
        );
      });
      expect(deliverMock).not.toHaveBeenCalled();
      const dropped = logSpurEventMock.mock.calls.find(
        ([, entry]) => entry.event === "trigger.send.dropped",
      );
      expect(dropped?.[1]?.details).toMatchObject({ reason: "closed_session" });
    } finally {
      await controller.stop();
    }
  });

  it("delivers a previously-queued send trigger once a live server-error wedge session leaves error", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce({
        id: "api-1",
        status: "running",
        state: "error",
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
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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

      await advanceSendWindow();

      expect(deliverMock).toHaveBeenCalledOnce();
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: false },
      );
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
    readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot([]));
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

  it("delivers interrupt:true trigger with interrupt:false after window when session is waiting", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config({ interrupt: true }) as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(githubEvent());
      // No early delivery — window must expire first.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(deliverMock).not.toHaveBeenCalled();

      // Window expires; delivers with interrupt:false (session is not working).
      await advanceSendWindow();
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
    readGitHubSourceSnapshotMock.mockReturnValue(mergeConflictSnapshot());
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

      // Flush ticks within the backoff window do not re-attempt the throw.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // After the first backoff (10s) the flush loop retries and succeeds.
      await vi.advanceTimersByTimeAsync(10_000);
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

  it("passes restrictWrites through to the session service", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-8" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: {
        dataDir: "/tmp/spur-data",
        projects: {
          api: {
            sources: {
              morning: { type: "cron" },
            },
            triggers: {
              kickoff: {
                source: "morning",
                event: "cron:tick",
                spawn: {
                  blocks: [{ prompt: "review only" }],
                  restrictWrites: true,
                },
              },
            },
          },
        },
      } as never,
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
          prompt: "review only",
          restrictWrites: true,
        });
      });
    } finally {
      await controller.stop();
    }
  });

  it("passes allowedTriggers through to the session service", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-8" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: {
        dataDir: "/tmp/spur-data",
        projects: {
          api: {
            sources: {
              morning: { type: "cron" },
            },
            triggers: {
              kickoff: {
                source: "morning",
                event: "cron:tick",
                spawn: {
                  blocks: [{ prompt: "review only" }],
                  allowedTriggers: [],
                },
              },
            },
          },
        },
      } as never,
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
          prompt: "review only",
          allowedTriggers: [],
        });
      });
    } finally {
      await controller.stop();
    }
  });

  it("drops send triggers when the session allowlist excludes them", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
      allowedTriggers: [],
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
        expect(
          logSpurEventMock.mock.calls.some(
            ([, entry]) =>
              entry.event === "trigger.send.dropped" &&
              entry.details?.reason === "trigger_not_allowed",
          ),
        ).toBe(true);
      });
      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("seeds the pr slot link when a work-item event spawns a session", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    useWorkItemLifecycleStore();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1);
      });
      expect(spawnMock).toHaveBeenCalledWith({
        project: "api",
        prompt: "Take https://github.com/acme/api/pull/42 from acme/api.",
        slots: { links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }] },
      });
      expect(recordWorkItemLifecycleMock).toHaveBeenCalledWith(
        DATA_DIR,
        "api",
        "pr-watch",
        expect.objectContaining({
          externalId: "acme/api#42",
          state: "running",
          sessionId: "api-9",
          url: "https://github.com/acme/api/pull/42",
          number: 42,
          title: "Fix the bug",
          repo: "acme/api",
          autoComplete: true,
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("spawns each work-item trigger block with the pr slot link", async () => {
    const spawnMock = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-9" })
      .mockResolvedValueOnce({ id: "api-10" });
    useWorkItemLifecycleStore();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemFanoutSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(spawnMock).toHaveBeenNthCalledWith(1, {
        project: "api",
        agent: "claude",
        prompt: "Claude review https://github.com/acme/api/pull/42.",
        slots: { links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }] },
      });
      expect(spawnMock).toHaveBeenNthCalledWith(2, {
        project: "api",
        agent: "codex",
        prompt: "Codex review https://github.com/acme/api/pull/42.",
        slots: { links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }] },
      });
    } finally {
      await controller.stop();
    }
  });

  it("applies restrictWrites and allowedTriggers to every work-item block", async () => {
    const spawnMock = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-9" })
      .mockResolvedValueOnce({ id: "api-10" });
    useWorkItemLifecycleStore();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemReadOnlyFanoutSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(spawnMock).toHaveBeenNthCalledWith(1, {
        project: "api",
        agent: "claude",
        model: "sonnet",
        prompt: "Claude review https://github.com/acme/api/pull/42.",
        restrictWrites: true,
        allowedTriggers: [],
        slots: { links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }] },
      });
      expect(spawnMock).toHaveBeenNthCalledWith(2, {
        project: "api",
        agent: "cursor",
        model: "composer-2.5",
        prompt: "Cursor review https://github.com/acme/api/pull/42.",
        restrictWrites: true,
        allowedTriggers: [],
        slots: { links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }] },
      });
      expect(recordWorkItemLifecycleMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        "api",
        "pr-watch",
        expect.objectContaining({
          externalId: "acme/api#42",
          state: "running",
          autoComplete: false,
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("spawns and tracks the work-item lifecycle for a sentry:issue.new event", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    useWorkItemLifecycleStore();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: sentrySpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(sentryEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1);
      });
      expect(spawnMock).toHaveBeenCalledWith({
        project: "api",
        prompt: "Triage https://sentry.io/issues/7/ from acme/web.",
        slots: { links: [{ label: "pr", url: "https://sentry.io/issues/7/" }] },
      });
      expect(recordWorkItemLifecycleMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        "api",
        "sentry-issues",
        expect.objectContaining({
          externalId: "acme/web#WEB-7",
          state: "running",
          sessionId: "api-9",
          autoComplete: true,
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("suppresses duplicate work-item events once a pending claim exists", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const records = useWorkItemLifecycleStore();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1);
      });
      expect(records.get("acme/api#42")).toEqual(
        expect.objectContaining({
          state: "running",
          sessionId: "api-9",
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("leaves a failed work-item claim and retries on the next event", async () => {
    const spawnMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce({ id: "api-10" });
    const records = useWorkItemLifecycleStore();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(records.get("acme/api#42")).toEqual(
          expect.objectContaining({
            state: "failed",
            error: "spawn failed",
          }),
        );
      });

      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(records.get("acme/api#42")).toEqual(
        expect.objectContaining({
          state: "running",
          sessionId: "api-10",
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("suppresses active and completed work-item owners", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-10" });
    const getMock = vi.fn().mockResolvedValue({
      id: "api-9",
      status: "running",
      state: "needs_input",
      workspaceExists: true,
    });
    useWorkItemLifecycleStore([runningWorkItemLifecycle()]);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { get: getMock, spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(getMock).toHaveBeenCalledWith("api-9");
      });
      expect(spawnMock).not.toHaveBeenCalled();

      readWorkItemLifecyclesMock.mockReturnValue(
        new Map([
          [
            "acme/api#42",
            {
              ...runningWorkItemLifecycle(),
              state: "completed",
              completedAt: new Date().toISOString(),
            },
          ],
        ]),
      );
      bus.emit(workItemEvent());
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("suppresses a work-item spawn while the owner is a live server-error wedge, not a duplicate spawn", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-10" });
    const getMock = vi.fn().mockResolvedValue({
      id: "api-9",
      status: "running",
      state: "error",
      workspaceExists: true,
    });
    useWorkItemLifecycleStore([runningWorkItemLifecycle()]);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { get: getMock, spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(getMock).toHaveBeenCalledWith("api-9");
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("replaces a stopped work-item owner once and suppresses later duplicates", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-10" });
    const getMock = vi.fn().mockImplementation((sessionId: string) =>
      Promise.resolve(
        sessionId === "api-9"
          ? {
              id: "api-9",
              status: "stopped",
              state: "stopped",
              workspaceExists: true,
            }
          : {
              id: sessionId,
              status: "running",
              state: "working",
              workspaceExists: true,
            },
      ),
    );
    useWorkItemLifecycleStore([runningWorkItemLifecycle()]);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { get: getMock, spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledTimes(1);
      });
      expect(spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project: "api",
          prompt: "Take https://github.com/acme/api/pull/42 from acme/api.",
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("auto-completes a waiting work-item session after the minimum age", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-9",
      status: "running",
      state: "waiting",
      workspaceExists: true,
    });
    const completeMock = vi.fn().mockResolvedValue(undefined);
    readWorkItemLifecyclesMock.mockReturnValue(
      new Map([
        [
          "acme/api#42",
          runningWorkItemLifecycle({
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
        ],
      ]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { get: getMock, complete: completeMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      await vi.waitFor(() => {
        expect(completeMock).toHaveBeenCalledWith("api-9", { prAction: "leave_open" });
      });
      expect(recordWorkItemLifecycleMock).toHaveBeenCalledWith(
        DATA_DIR,
        "api",
        "pr-watch",
        expect.objectContaining({
          externalId: "acme/api#42",
          state: "completed",
          sessionId: "api-9",
        }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("blocks auto-complete before the minimum age or while needs_input", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-9",
      status: "running",
      state: "needs_input",
      workspaceExists: true,
    });
    const completeMock = vi.fn().mockResolvedValue(undefined);
    readWorkItemLifecyclesMock.mockReturnValue(
      new Map([
        [
          "acme/api#42",
          runningWorkItemLifecycle({
            createdAt: new Date(Date.now() - 10_000).toISOString(),
          }),
        ],
      ]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { get: getMock, complete: completeMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(completeMock).not.toHaveBeenCalled();

      readWorkItemLifecyclesMock.mockReturnValue(
        new Map([
          [
            "acme/api#42",
            runningWorkItemLifecycle({
              createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            }),
          ],
        ]),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(getMock).toHaveBeenCalled();
      });
      expect(completeMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("fails a spawn trigger when prompt placeholders are missing", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig({ prompt: "Take {{missing}}." }) as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
          "trigger.spawn.failed",
        );
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("holds delivery while the session was active in the last 30s", async () => {
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
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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

      await advanceSendWindow();
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

  it("logs spawn.failed when prompt template references a missing placeholder", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig({ prompt: "Take {{nonexistent}}." }) as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        const failedEntry = logSpurEventMock.mock.calls.find(
          ([, entry]) => entry.event === "trigger.spawn.failed",
        );
        expect(failedEntry).toBeDefined();
        expect(failedEntry?.[1].message).toContain("nonexistent");
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("logs spawn.failed when autoComplete=true is configured on a non-work-item event", async () => {
    const spawnMock = vi.fn();
    const cronAutoCompleteConfig = {
      dataDir: "/tmp/spur-data",
      projects: {
        api: {
          sources: {
            morning: { type: "cron" },
          },
          triggers: {
            kickoff: {
              source: "morning",
              event: "cron:tick",
              spawn: {
                blocks: [
                  {
                    prompt: "ship the task",
                  },
                ],
                autoComplete: true,
              },
            },
          },
        },
      },
    };
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: cronAutoCompleteConfig as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(cronEvent());
      await vi.waitFor(() => {
        const failedEntry = logSpurEventMock.mock.calls.find(
          ([, entry]) => entry.event === "trigger.spawn.failed",
        );
        expect(failedEntry).toBeDefined();
        expect(failedEntry?.[1].message).toContain("incompatible work-item payload");
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it("persists a queued send batch to disk on write-through", async () => {
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
      await vi.waitFor(() => {
        expect(recordPendingSendBatchMock).toHaveBeenCalledWith(
          DATA_DIR,
          expect.objectContaining({
            queueKey: "api:send:api-1",
            projectId: "api",
            triggerId: "send",
            sourceId: "pr-watch",
            batch: expect.objectContaining({
              kind: "review",
              sessionId: "api-1",
            }),
          }),
        );
      });
    } finally {
      await controller.stop();
    }
  });

  it("clears the persisted record after a successful delivery", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deletePendingSendBatchMock).toHaveBeenCalledWith(DATA_DIR, "api:send:api-1");
    } finally {
      await controller.stop();
    }
  });

  it("leaves the pending batch intact and logs a suppression event when delivery is rate limited", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    // Import after loadTriggersModule()'s vi.resetModules() so this resolves to the same
    // session-service.js module instance triggers.ts uses internally for the instanceof check.
    const { SessionRateLimitedError } = await import("../../src/session-service.js");
    const deliverMock = vi.fn().mockRejectedValue(new SessionRateLimitedError("rate limited"));
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
      await vi.advanceTimersByTimeAsync(30_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deletePendingSendBatchMock).not.toHaveBeenCalled();
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.send.suppressed_rate_limited",
      );
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.delivered",
      );
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.failed",
      );
    } finally {
      await controller.stop();
    }
  });

  it("never drops the pending batch when every delivery attempt is rate limited across the full backoff schedule", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    readGitHubSourceSnapshotMock.mockImplementation(() => commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    // Import after loadTriggersModule()'s vi.resetModules() so this resolves to the same
    // session-service.js module instance triggers.ts uses internally for the instanceof check.
    const { SessionRateLimitedError } = await import("../../src/session-service.js");
    const deliverMock = vi.fn().mockRejectedValue(new SessionRateLimitedError("rate limited"));
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
      await vi.advanceTimersByTimeAsync(30_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      // Advance through the same total window as the 8-attempt exponential
      // backoff cap used for ordinary delivery failures (10s..640s). Rate-limit
      // suppression must never consume that budget, so the batch stays queued
      // and every attempt keeps retrying instead of tripping the drop path.
      const backoffsMs = [10, 20, 40, 80, 160, 320, 640].map((seconds) => seconds * 1_000);
      for (const backoff of backoffsMs) {
        await vi.advanceTimersByTimeAsync(backoff);
      }

      expect(deliverMock.mock.calls.length).toBeGreaterThan(8);
      expect(deletePendingSendBatchMock).not.toHaveBeenCalled();
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.dropped",
      );
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
        "trigger.send.failed",
      );
    } finally {
      await controller.stop();
    }
  });

  it("restores a persisted batch on startup and delivers it via the flush loop", async () => {
    const persisted: PersistedPendingBatch = {
      queueKey: "api:send:api-1",
      projectId: "api",
      triggerId: "send",
      sourceId: "pr-watch",
      batch: {
        kind: "review",
        providerId: "github",
        projectId: "api",
        sourceId: "pr-watch",
        sessionId: "api-1",
        prNumber: 42,
        prTitle: "Tighten coverage",
        signals: [{ key: "comment:1", kind: "comment", text: "A new comment arrived." }],
      },
    };
    readPendingSendBatchesMock.mockReturnValue(new Map([[persisted.queueKey, persisted]]));
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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
      logger: { warn: vi.fn() },
    });

    try {
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "trigger.send.restored",
      );
      await advanceSendWindow();
      expect(deliverMock).toHaveBeenCalledWith(
        "api-1",
        expect.stringContaining("A new comment arrived."),
        { interrupt: false },
      );
    } finally {
      await controller.stop();
    }
  });

  it("resumes the ci_failed retry cadence for a persisted batch restored on startup", async () => {
    const persisted: PersistedPendingBatch = {
      queueKey: "api:send:api-1",
      projectId: "api",
      triggerId: "send",
      sourceId: "pr-watch",
      batch: {
        kind: "review",
        providerId: "github",
        projectId: "api",
        sourceId: "pr-watch",
        sessionId: "api-1",
        prNumber: 42,
        prTitle: "Tighten coverage",
        signals: [{ key: "ci_failed", kind: "ci_failed", text: "CI is failing: test suite." }],
      },
    };
    readPendingSendBatchesMock.mockReturnValue(new Map([[persisted.queueKey, persisted]]));
    readGitHubSourceSnapshotMock.mockImplementation(() => ciSnapshot());
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
      config: config({ event: "github:ci_failed", interrupt: false }) as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: { warn: vi.fn() },
    });

    try {
      // Window (fresh on restore) holds delivery for 30 s.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(3);
    } finally {
      await controller.stop();
    }
  });

  it("deletes and logs restore_skipped for a persisted record whose trigger no longer exists", async () => {
    const stalePersisted: PersistedPendingBatch = {
      queueKey: "api:missing-trigger:api-1",
      projectId: "api",
      triggerId: "missing-trigger",
      sourceId: "pr-watch",
      batch: {
        kind: "review",
        providerId: "github",
        projectId: "api",
        sourceId: "pr-watch",
        sessionId: "api-1",
        prNumber: 42,
        prTitle: "Tighten coverage",
        signals: [],
      },
    };
    readPendingSendBatchesMock.mockReturnValue(
      new Map([[stalePersisted.queueKey, stalePersisted]]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
      bus,
      sessionService: {} as never,
      logger: { warn: vi.fn() },
    });

    try {
      expect(deletePendingSendBatchMock).toHaveBeenCalledWith(DATA_DIR, stalePersisted.queueKey);
      const skippedEntry = logSpurEventMock.mock.calls.find(
        ([, entry]) => entry.event === "trigger.send.restore_skipped",
      );
      expect(skippedEntry?.[1].details).toEqual(
        expect.objectContaining({ reason: "trigger_missing_or_changed" }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("deletes and logs restore_skipped for a persisted record with an unparseable batch", async () => {
    const invalidPersisted = {
      queueKey: "api:send:api-1",
      projectId: "api",
      triggerId: "send",
      sourceId: "pr-watch",
      batch: {
        kind: "review",
        providerId: "github",
        projectId: "api",
        sourceId: "pr-watch",
        sessionId: "api-1",
        prTitle: "Tighten coverage",
        signals: [],
      },
    } as unknown as PersistedPendingBatch;
    readPendingSendBatchesMock.mockReturnValue(
      new Map([[invalidPersisted.queueKey, invalidPersisted]]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: config() as never,
      bus,
      sessionService: {} as never,
      logger: { warn: vi.fn() },
    });

    try {
      expect(deletePendingSendBatchMock).toHaveBeenCalledWith(DATA_DIR, invalidPersisted.queueKey);
      const skippedEntry = logSpurEventMock.mock.calls.find(
        ([, entry]) => entry.event === "trigger.send.restore_skipped",
      );
      expect(skippedEntry?.[1].details).toEqual(
        expect.objectContaining({ reason: "invalid_payload" }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("logs persisted_on_stop for each remaining pending batch when stopping", async () => {
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
      config: config() as never,
      bus,
      sessionService: {
        get: getMock,
        deliver: deliverMock,
      } as never,
      logger: { warn: vi.fn() },
    });

    bus.emit(githubEvent());
    await vi.waitFor(() => {
      expect(recordPendingSendBatchMock).toHaveBeenCalled();
    });

    await controller.stop();

    const persistedOnStopEntry = logSpurEventMock.mock.calls.find(
      ([, entry]) => entry.event === "trigger.send.persisted_on_stop",
    );
    expect(persistedOnStopEntry).toBeDefined();
    expect(persistedOnStopEntry?.[1].details).toEqual(
      expect.objectContaining({ queueKey: "api:send:api-1" }),
    );
  });
});
