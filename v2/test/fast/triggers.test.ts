import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoPingService, autoPingRouteFingerprint } from "../../src/auto-ping.js";
import type * as eventLogModule from "../../src/event-log.js";
import type * as githubProviderModule from "../../src/review-providers/github.js";
import type {
  RefreshReviewSignalsInput,
  ReviewSignalRefreshResult,
} from "../../src/review-providers/types.js";
import { EventBus } from "../../src/event-bus.js";
import type {
  AutoPingRouteDescriptor,
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
const readPendingSendBatchMock = vi.fn();
const updatePendingSendBatchConditionalMock = vi.fn();
const deletePendingSendBatchConditionalMock = vi.fn();
const logSpurEventMock = vi.fn();
const refreshSignalsMock =
  vi.fn<(input: RefreshReviewSignalsInput) => Promise<ReviewSignalRefreshResult[]>>();
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
  readPendingSendBatch: readPendingSendBatchMock,
  updatePendingSendBatchConditional: updatePendingSendBatchConditionalMock,
  deletePendingSendBatchConditional: deletePendingSendBatchConditionalMock,
}));

vi.mock("../../src/review-providers/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof githubProviderModule>();
  return {
    ...actual,
    githubReviewProvider: { ...actual.githubReviewProvider, refreshSignals: refreshSignalsMock },
  };
});

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

function webhookSpawnConfig() {
  return {
    dataDir: DATA_DIR,
    projects: {
      api: {
        sources: {
          incoming: {
            type: "webhook",
          },
        },
        triggers: {
          receive: {
            source: "incoming",
            event: "webhook:received",
            spawn: {
              blocks: [{ prompt: "Body={{body}} At={{receivedAt}}" }],
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
                  reasoningEffort: "xhigh",
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

function spawnDeskGroupConfig(options?: { thirdBlock?: boolean }) {
  const thirdBlock = options?.thirdBlock
    ? [
        {
          prompt: "tests for {{task}}",
          steps: ["verify"],
          agent: "cursor",
          overrides: {
            worktree: false,
          },
        },
      ]
    : [];
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
                ...thirdBlock,
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
    occurrenceId: "sentry-occurrence-1",
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
    occurrenceId: `github-${signalKey}`,
    projectId: "api",
    sourceId: "pr-watch",
    data: {
      sessionId: "api-1",
      repo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [
        {
          key: signalKey,
          kind: "comment" as const,
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
    occurrenceId: `gitlab-${signalKey}`,
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
    occurrenceId: "github-ci-failed-1",
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
          kind: "ci_failed" as const,
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
    occurrenceId: "github-merge-conflict-1",
    projectId: "api",
    sourceId: "pr-watch",
    data: {
      sessionId: "api-1",
      repo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
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
      kind: "ci_failed" as const,
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
    occurrenceId: "cron-occurrence-1",
    projectId: "api",
    sourceId: "morning",
    data: {},
  };
}

function webhookEvent() {
  return {
    name: "webhook:received",
    occurrenceId: "webhook-occurrence-1",
    projectId: "api",
    sourceId: "incoming",
    data: {
      body: '{"kind":"deploy"}',
      receivedAt: "2026-09-08T12:00:00.000Z",
    },
  };
}

function fanoutCronEvent() {
  return {
    name: "cron:tick",
    occurrenceId: "fanout-cron-occurrence-1",
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
    occurrenceId: `service-${ruleId}-1`,
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
    occurrenceId: "work-item-occurrence-1",
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
  const module = await import("../../src/triggers.js");
  type TriggerDeps = Parameters<typeof module.startConfiguredTriggers>[0];
  return {
    ...module,
    startConfiguredTriggers(deps: Omit<TriggerDeps, "autoPing"> & { autoPing?: AutoPingService }) {
      if (deps.autoPing) return module.startConfiguredTriggers(deps as TriggerDeps);
      const policyDir = mkdtempSync(join(tmpdir(), "spur-trigger-policy-"));
      const autoPing = new AutoPingService(policyDir);
      const sessionService = Object.create(deps.sessionService) as TriggerDeps["sessionService"];
      sessionService.deliver = async (sessionId, message, options) =>
        deps.sessionService.deliver(sessionId, message, {
          ...(options?.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
        });
      const controller = module.startConfiguredTriggers({
        ...deps,
        sessionService,
        autoPing,
      } as TriggerDeps);
      return {
        async stop(): Promise<void> {
          await controller.stop();
          autoPing.dispose();
          rmSync(policyDir, { recursive: true, force: true });
        },
      };
    },
  };
}

async function advanceSendWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(35_000);
}

describe("startConfiguredTriggers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshSignalsMock
      .mockReset()
      .mockImplementation(async (input) =>
        input.signals.map((signal) => ({ status: "live", key: signal.key, signal })),
      );
    readGitHubSourceSnapshotMock.mockReset().mockReturnValue(null);
    readReviewSourceSnapshotMock.mockReset().mockReturnValue(null);
    readWorkItemLifecyclesMock.mockReset().mockReturnValue(new Map());
    recordWorkItemLifecycleMock.mockReset();
    deleteWorkItemLifecycleMock.mockReset();
    readPendingSendBatchesMock.mockReset().mockReturnValue(new Map());
    recordPendingSendBatchMock
      .mockReset()
      .mockImplementation((_dataDir: string, record: PersistedPendingBatch) => {
        readPendingSendBatchesMock().set(record.queueKey, record);
      });
    deletePendingSendBatchMock
      .mockReset()
      .mockImplementation((_dataDir: string, queueKey: string) => {
        readPendingSendBatchesMock().delete(queueKey);
      });
    readPendingSendBatchMock
      .mockReset()
      .mockImplementation(
        (_dataDir: string, workId: string) =>
          [...readPendingSendBatchesMock().values()].find(
            (record: PersistedPendingBatch) => record.workId === workId,
          ) ?? null,
      );
    updatePendingSendBatchConditionalMock
      .mockReset()
      .mockImplementation(
        (
          _dataDir: string,
          expected: { workId: string; revision: number; claimId?: string },
          next: PersistedPendingBatch,
        ) => {
          const records = readPendingSendBatchesMock();
          const current = [...records.values()].find(
            (record: PersistedPendingBatch) => record.workId === expected.workId,
          );
          if (
            !current ||
            current.revision !== expected.revision ||
            (expected.claimId !== undefined && current.claim?.claimId !== expected.claimId)
          ) {
            return false;
          }
          records.set(next.queueKey, next);
          return true;
        },
      );
    deletePendingSendBatchConditionalMock
      .mockReset()
      .mockImplementation(
        (_dataDir: string, expected: { workId: string; revision?: number; claimId?: string }) => {
          const records = readPendingSendBatchesMock();
          const current = [...records.values()].find(
            (record: PersistedPendingBatch) => record.workId === expected.workId,
          );
          if (
            !current ||
            (expected.revision !== undefined && current.revision !== expected.revision) ||
            (expected.claimId !== undefined && current.claim?.claimId !== expected.claimId)
          ) {
            return false;
          }
          records.delete(current.queueKey);
          return true;
        },
      );
    logSpurEventMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("stale teardown", () => {
    it.each(
      ["github", "service"].flatMap((source) =>
        [false, true].flatMap((interrupt) =>
          ["prior queued", "arrival during teardown"].map((arrival) => ({
            source,
            interrupt,
            arrival,
          })),
        ),
      ),
    )(
      "retains $source $arrival with interrupt=$interrupt until stale wake",
      async ({ source, interrupt, arrival }) => {
        const session = {
          id: "api-1",
          status: "running",
          state: arrival === "prior queued" ? "waiting" : "stopped",
          workspaceExists: true,
          lastActivityAt: recentActivity(),
        };
        const get = vi.fn().mockImplementation(async () => ({ ...session }));
        const deliver = vi.fn().mockResolvedValue(undefined);
        readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
        const triggerConfig = source === "github" ? config({ interrupt }) : serviceConfig();
        if ("notify" in triggerConfig.projects.api.triggers) {
          triggerConfig.projects.api.triggers.notify.send.interrupt = interrupt;
        }
        const { startConfiguredTriggers } = await loadTriggersModule();
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config: triggerConfig as never,
          bus,
          sessionService: { get, deliver } as never,
          logger: { warn: vi.fn() },
        });
        try {
          bus.emit(source === "github" ? githubEvent() : serviceEvent());
          await vi.advanceTimersByTimeAsync(1);
          expect(readPendingSendBatchesMock().size).toBe(1);
          session.state = "stopped";
          await vi.advanceTimersByTimeAsync(35_000);
          const pending = [...readPendingSendBatchesMock().values()][0] as PersistedPendingBatch;
          expect(pending).toBeDefined();
          expect(pending.claim).toBeUndefined();
          expect(pending.retryAccounting?.every((entry) => entry.deliveryAttempts === 0)).toBe(
            true,
          );
          expect(updatePendingSendBatchConditionalMock).not.toHaveBeenCalled();
          expect(deliver).not.toHaveBeenCalled();
          expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
            "trigger.send.dropped",
          );

          Object.assign(session, {
            status: "stopped",
            state: "stale",
            stopReason: "stale_timeout",
          });
          await vi.advanceTimersByTimeAsync(5_000);
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(deliver).toHaveBeenCalledWith("api-1", expect.any(String), { interrupt: false });
          expect(readPendingSendBatchesMock().size).toBe(0);
          await vi.advanceTimersByTimeAsync(35_000);
          expect(deliver).toHaveBeenCalledTimes(1);
        } finally {
          await controller.stop();
        }
      },
    );

    it.each([
      { status: "stopped", state: "stopped" },
      { status: "stopped", state: "stopped", stopReason: "manual_pause" },
      { status: "errored", state: "error" },
      { status: "killed", state: "killed" },
    ])("drops genuinely closed queued work after $status/$state", async (closed) => {
      const get = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        workspaceExists: true,
        lastActivityAt: recentActivity(),
      });
      const deliver = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      });
      try {
        bus.emit(githubEvent());
        await vi.advanceTimersByTimeAsync(1);
        expect(readPendingSendBatchesMock().size).toBe(1);
        get.mockResolvedValue({ id: "api-1", workspaceExists: true, ...closed });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(readPendingSendBatchesMock().size).toBe(0);
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await controller.stop();
      }
    });
  });

  describe("persisted live feedback", () => {
    const pending = (): PersistedPendingBatch | undefined =>
      readPendingSendBatchesMock().get("api:send:api-1");
    const running = (path: string) => ({
      id: "api-1",
      status: path === "stale" ? "stopped" : "running",
      state: path === "stale" ? "stale" : path === "interrupt" ? "working" : "waiting",
      stopReason: "stale_timeout",
      workspaceExists: true,
      worktreePath: "/removed/worktree",
      lastActivityAt: staleActivity(),
    });
    const emit = (
      bus: EventBus,
      signals: ReviewSignal[],
      overrides: { prUrl?: string | undefined; repo?: string | undefined } = {},
    ) => {
      readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot(signals));
      bus.emit({
        ...githubEvent(),
        occurrenceId: `fresh-${Date.now()}`,
        data: { ...githubEvent().data, ...overrides, signals },
      });
    };

    describe("admission cap", () => {
      it.each(["queued", "stale", "interrupt"])(
        "holds the whole backlog and new edits on %s delivery beyond eight denials",
        async (path) => {
          const { startConfiguredTriggers } = await loadTriggersModule();
          const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
          const get = vi.fn().mockResolvedValue(running(path));
          const deliver = vi.fn().mockRejectedValue(new SessionAdmissionDeniedError("full", "cap"));
          const bus = new EventBus();
          const controller = startConfiguredTriggers({
            config: config({ interrupt: path === "interrupt" }) as never,
            bus,
            sessionService: { get, deliver } as never,
            logger: { warn: vi.fn() },
          });
          const signals: ReviewSignal[] = Array.from({ length: 8 }, (_, index) => ({
            key: `comment:${index + 1}`,
            kind: "comment",
            text: `original ${index + 1}`,
          }));
          try {
            emit(bus, signals);
            await vi.advanceTimersByTimeAsync(path === "queued" ? 35_000 : 1);
            expect(deliver).toHaveBeenCalledTimes(1);
            const deadline = pending()?.admissionCapRetryAt;
            if (!deadline) throw new Error("Missing cap deadline");
            const claims = updatePendingSendBatchConditionalMock.mock.calls.length;
            const edited: ReviewSignal = {
              key: "comment:1",
              kind: "comment",
              text: "new event edit",
            };
            await vi.advanceTimersByTimeAsync(Math.min(5_000, deadline - Date.now() - 2));
            emit(bus, [edited, { key: "comment:9", kind: "comment", text: "new arrival" }]);
            readGitHubSourceSnapshotMock.mockReturnValue(
              storedSnapshot([
                edited,
                ...signals.slice(1),
                { key: "comment:9", kind: "comment", text: "new arrival" },
              ]),
            );
            await vi.advanceTimersByTimeAsync(1);
            expect(pending()?.admissionCapRetryAt).toBe(deadline);
            expect(pending()?.admissionCapDenials).toBe(1);
            expect(refreshSignalsMock).toHaveBeenCalledTimes(1);
            expect(deliver).toHaveBeenCalledTimes(1);
            expect(updatePendingSendBatchConditionalMock).toHaveBeenCalledTimes(claims);
            expect(pending()?.retryAccounting?.every((entry) => entry.deliveryAttempts === 0)).toBe(
              true,
            );
            for (let attempt = 2; attempt <= 10; attempt += 1) {
              const nextDeadline = pending()?.admissionCapRetryAt;
              if (!nextDeadline) throw new Error("Missing growing deadline");
              const ownedWrites = updatePendingSendBatchConditionalMock.mock.calls.length;
              await vi.advanceTimersByTimeAsync(nextDeadline - Date.now() - 1);
              expect(refreshSignalsMock).toHaveBeenCalledTimes(attempt - 1);
              expect(deliver).toHaveBeenCalledTimes(attempt - 1);
              expect(updatePendingSendBatchConditionalMock).toHaveBeenCalledTimes(ownedWrites);
              await vi.advanceTimersByTimeAsync(1);
              expect(deliver).toHaveBeenCalledTimes(attempt);
              expect(pending()?.admissionCapDenials).toBe(Math.min(attempt, 7));
              expect((pending()?.admissionCapRetryAt ?? 0) - Date.now()).toBe(
                [10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000][
                  Math.min(attempt, 7) - 1
                ],
              );
              expect(refreshSignalsMock.mock.calls.at(-1)?.[0].signals).toHaveLength(4);
              expect(
                refreshSignalsMock.mock.calls.at(-1)?.[0].signals.map((signal) => signal.key),
              ).toEqual(["comment:1", "comment:2", "comment:3", "comment:4"]);
              expect(pending()?.retryAccounting).toHaveLength(9);
              expect(
                pending()?.retryAccounting?.every((entry) => entry.deliveryAttempts === 0),
              ).toBe(true);
            }
            expect(deliver.mock.calls[1]?.[1]).toContain("new event edit");
          } finally {
            await controller.stop();
          }
        },
      );

      it.each(["queued", "stale"])(
        "bounds one-hour lookup pressure on %s delivery",
        async (path) => {
          const { startConfiguredTriggers } = await loadTriggersModule();
          const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
          const get = vi.fn().mockResolvedValue(running(path));
          const deliver = vi.fn().mockRejectedValue(new SessionAdmissionDeniedError("full", "cap"));
          const bus = new EventBus();
          const controller = startConfiguredTriggers({
            config: config() as never,
            bus,
            sessionService: { get, deliver } as never,
            logger: { warn: vi.fn() },
          });
          try {
            emit(
              bus,
              Array.from({ length: 9 }, (_, index) => ({
                key: `comment:${index + 1}`,
                kind: "comment",
                text: `body ${index + 1}`,
              })),
            );
            await vi.advanceTimersByTimeAsync(path === "queued" ? 35_000 : 1);
            const firstDenialAt = (pending()?.admissionCapRetryAt ?? 0) - 10_000;
            expect(deliver).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(firstDenialAt + 3_600_000 - Date.now());
            expect(deliver.mock.calls.length).toBeLessThanOrEqual(11);
            expect(refreshSignalsMock.mock.calls.length).toBe(deliver.mock.calls.length);
            expect(
              refreshSignalsMock.mock.calls.reduce(
                (count, [input]) => count + input.signals.length,
                0,
              ),
            ).toBeLessThanOrEqual(44);
            expect(pending()?.admissionCapDenials).toBe(7);
            expect(pending()?.retryAccounting).toHaveLength(9);
            expect(pending()?.retryAccounting?.every((entry) => entry.deliveryAttempts === 0)).toBe(
              true,
            );
          } finally {
            await controller.stop();
          }
        },
      );

      it("retains count-only growth through expired event serialization and reload", async () => {
        const { startConfiguredTriggers } = await loadTriggersModule();
        const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
        const get = vi.fn().mockResolvedValue(running("interrupt"));
        const deliver = vi.fn().mockRejectedValue(new SessionAdmissionDeniedError("full", "cap"));
        const bus = new EventBus();
        const deps = {
          config: config() as never,
          bus,
          sessionService: { get, deliver } as never,
          logger: { warn: vi.fn() },
        };
        let controller = startConfiguredTriggers(deps);
        try {
          emit(bus, [{ key: "comment:1", kind: "comment", text: "queued" }]);
          await vi.advanceTimersByTimeAsync(1);
          const record = pending();
          if (!record) throw new Error("Missing queued work");
          record.admissionCapDenials = 2;
          record.admissionCapRetryAt = Date.now() - 1;
          await controller.stop();
          controller = startConfiguredTriggers(deps);
          emit(bus, [{ key: "comment:1", kind: "comment", text: "new edit after expiry" }]);
          await vi.advanceTimersByTimeAsync(1);
          expect(pending()?.admissionCapRetryAt).toBeUndefined();
          expect(pending()?.admissionCapDenials).toBe(2);
          await controller.stop();
          get.mockResolvedValue(running("stale"));
          controller = startConfiguredTriggers(deps);
          await vi.advanceTimersByTimeAsync(5_000);
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(pending()?.admissionCapDenials).toBe(3);
          expect(pending()?.admissionCapRetryAt).toBe(Date.now() + 40_000);
          expect(pending()?.retryAccounting?.[0]?.deliveryAttempts).toBe(0);
        } finally {
          await controller.stop();
        }
      });

      it.each(["historical", "post-denial"])(
        "preserves the deadline across reload with %s stop history and prior refunded attempts",
        async (history) => {
          const { startConfiguredTriggers } = await loadTriggersModule();
          const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
          const get = vi.fn().mockResolvedValue(running("stale"));
          const deliver = vi.fn().mockRejectedValue(new SessionAdmissionDeniedError("full", "cap"));
          const bus = new EventBus();
          const deps = {
            config: config() as never,
            bus,
            sessionService: { get, deliver } as never,
            logger: { warn: vi.fn() },
          };
          let controller = startConfiguredTriggers(deps);
          try {
            emit(bus, [{ key: "comment:1", kind: "comment", text: "body" }]);
            await vi.advanceTimersByTimeAsync(10_001);
            const record = pending();
            if (!record?.admissionCapRetryAt || !record.retryAccounting?.[0])
              throw new Error("Missing held work");
            const deadline = record.admissionCapRetryAt;
            expect(record.admissionCapDenials).toBe(2);
            record.retryAccounting[0].deliveryAttempts = 3;
            get.mockResolvedValue({
              ...running("stale"),
              stateHistory: [
                {
                  state: "stale",
                  at: new Date(
                    deadline - (history === "historical" ? 25_000 : 19_000),
                  ).toISOString(),
                },
              ],
            });
            await vi.advanceTimersByTimeAsync(2_000);
            await controller.stop();
            controller = startConfiguredTriggers(deps);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(pending()?.admissionCapRetryAt).toBe(deadline);
            expect(refreshSignalsMock).toHaveBeenCalledTimes(2);
            expect(pending()?.admissionCapDenials).toBe(2);
            expect(pending()?.retryAccounting?.[0]?.deliveryAttempts).toBe(3);
            await vi.advanceTimersByTimeAsync(deadline - Date.now() + 5_000);
            expect(deliver).toHaveBeenCalledTimes(3);
            expect(pending()?.admissionCapDenials).toBe(3);
            expect(pending()?.admissionCapRetryAt).toBeGreaterThanOrEqual(Date.now() + 35_000);
            expect(pending()?.retryAccounting?.[0]?.deliveryAttempts).toBe(3);
          } finally {
            await controller.stop();
          }
        },
      );

      it("starts the hold at denial completion after a slow lookup and clears it from remaining work on success", async () => {
        const { startConfiguredTriggers } = await loadTriggersModule();
        const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
        const get = vi.fn().mockResolvedValue(running("stale"));
        const deliver = vi
          .fn()
          .mockRejectedValueOnce(new SessionAdmissionDeniedError("full", "cap"))
          .mockRejectedValueOnce(new SessionAdmissionDeniedError("full", "cap"))
          .mockResolvedValue(undefined);
        let release!: () => void;
        const lookup = new Promise<void>((resolve) => {
          release = resolve;
        });
        refreshSignalsMock.mockImplementation(async (input) => {
          if (refreshSignalsMock.mock.calls.length === 2) await lookup;
          return input.signals.map((signal) =>
            signal.key === "comment:2"
              ? { status: "failed", key: signal.key, error: "HTTP 403" }
              : { status: "live", key: signal.key, signal },
          );
        });
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config: config() as never,
          bus,
          sessionService: { get, deliver } as never,
          logger: { warn: vi.fn() },
        });
        try {
          emit(bus, [
            { key: "comment:1", kind: "comment", text: "current body" },
            { key: "comment:2", kind: "comment", text: "unavailable cached body" },
            { key: "ci_failed", kind: "ci_failed", text: "failed CI" },
          ]);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(deliver).toHaveBeenCalledTimes(1);
          const deniedAt = Date.now();
          release();
          await vi.advanceTimersByTimeAsync(1);
          expect(pending()?.admissionCapRetryAt).toBe(deniedAt + 20_000);
          expect(pending()?.admissionCapDenials).toBe(2);
          await vi.advanceTimersByTimeAsync(19_998);
          expect(refreshSignalsMock).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(5_001);
          expect(deliver).toHaveBeenCalledTimes(3);
          expect(pending()?.admissionCapRetryAt).toBeUndefined();
          expect(pending()?.admissionCapDenials).toBeUndefined();
          expect(
            pending()?.retryAccounting?.find((entry) => entry.itemKey.includes("ci_failed")),
          ).toMatchObject({ ciAttempts: 1, deliveryAttempts: 1 });
          expect(
            pending()?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:2")),
          ).toMatchObject({ deliveryAttempts: 3 });
          expect(deliver.mock.calls[2]?.[1]).toContain("current body");
          expect(deliver.mock.calls[2]?.[1]).not.toContain("unavailable cached body");
          expect(
            updatePendingSendBatchConditionalMock.mock.calls.at(-1)?.[2].admissionCapRetryAt,
          ).toBeUndefined();
          expect(
            updatePendingSendBatchConditionalMock.mock.calls.at(-1)?.[2].admissionCapDenials,
          ).toBeUndefined();
          deliver.mockRejectedValue(new SessionAdmissionDeniedError("full", "cap"));
          emit(bus, [{ key: "comment:3", kind: "comment", text: "later current body" }]);
          await vi.advanceTimersByTimeAsync(1);
          expect(pending()?.admissionCapDenials).toBe(1);
          expect(pending()?.admissionCapRetryAt).toBe(Date.now() + 9_999);
        } finally {
          await controller.stop();
        }
      });

      it.each(["work", "revision"])(
        "cannot stamp a late denial onto replacement %s and rereads an absent authoritative hold",
        async (replacement) => {
          const { startConfiguredTriggers } = await loadTriggersModule();
          const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
          let reject!: (error: Error) => void;
          const response = new Promise<void>((_resolve, fail) => {
            reject = fail;
          });
          const deliver = vi.fn().mockReturnValueOnce(response).mockResolvedValue(undefined);
          const get = vi.fn().mockResolvedValue(running("stale"));
          const bus = new EventBus();
          const deps = {
            config: config() as never,
            bus,
            sessionService: { get, deliver } as never,
            logger: { warn: vi.fn() },
          };
          let controller = startConfiguredTriggers(deps);
          try {
            emit(bus, [{ key: "comment:1", kind: "comment", text: "body" }]);
            await vi.advanceTimersByTimeAsync(1);
            const claimed = pending();
            if (!claimed) throw new Error("Missing claimed work");
            const next = {
              ...claimed,
              workId: replacement === "work" ? "replacement-work" : claimed.workId,
              revision: (claimed.revision ?? 0) + 1,
              claim: undefined,
              retryAccounting: claimed.retryAccounting?.map((entry) => ({
                ...entry,
                deliveryAttempts: 0,
                nextAttemptAt: 0,
              })),
            };
            readPendingSendBatchesMock().set(next.queueKey, next);
            reject(new SessionAdmissionDeniedError("full", "cap"));
            await vi.advanceTimersByTimeAsync(1);
            expect(pending()).toEqual(next);
            expect(pending()?.admissionCapRetryAt).toBeUndefined();
            expect(pending()?.admissionCapDenials).toBeUndefined();
            if (replacement === "work") {
              await controller.stop();
              controller = startConfiguredTriggers(deps);
            }
            await vi.advanceTimersByTimeAsync(5_000);
            expect(deliver).toHaveBeenCalledTimes(2);
            expect(pending()).toBeUndefined();
          } finally {
            await controller.stop();
          }
        },
      );
    });

    it.each(["queued", "stale", "interrupt"])(
      "resolves edited and deleted feedback on %s delivery",
      async (path) => {
        const get = vi.fn().mockResolvedValue(running(path));
        const deliver = vi.fn().mockResolvedValue(undefined);
        const signals: ReviewSignal[] = [
          { key: "comment:1", kind: "comment", text: "cached" },
          { key: "comment:2", kind: "comment", text: "deleted" },
        ];
        refreshSignalsMock.mockImplementation(async (input) => {
          expect(input.cwd).toBe(DATA_DIR);
          expect(input.hostname).toBe("git.example.com");
          expect(pending()?.claim?.claimId).toBeTruthy();
          expect(
            pending()?.retryAccounting?.filter((entry) => entry.deliveryAttempts === 1),
          ).toHaveLength(2);
          return input.signals.map((signal) =>
            signal.key === "comment:2"
              ? { status: "deleted", key: signal.key }
              : { status: "live", key: signal.key, signal: { ...signal, text: "current body" } },
          );
        });
        const { startConfiguredTriggers } = await loadTriggersModule();
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config: config({ interrupt: path === "interrupt", prompt: "review" }) as never,
          bus,
          sessionService: { get, deliver } as never,
          logger: { warn: vi.fn() },
        });
        try {
          emit(bus, signals, { prUrl: "https://git.example.com/acme/api/pull/42" });
          await vi.advanceTimersByTimeAsync(path === "queued" ? 35_000 : 1);
          expect(deliver).toHaveBeenCalledWith("api-1", expect.stringContaining("current body"), {
            interrupt: path === "interrupt",
          });
          expect(deliver.mock.calls[0]?.[1]).not.toContain("cached");
          expect(deliver.mock.calls[0]?.[1]).not.toContain("deleted");
          expect(inputLogEntries("api-1")).toHaveLength(1);
          expect(pending()).toBeUndefined();
        } finally {
          await controller.stop();
        }
      },
    );

    it("charges only the selected four and advances deferred siblings during failed-item backoff", async () => {
      const signals: ReviewSignal[] = Array.from({ length: 6 }, (_, index) => ({
        key: `comment:${index + 1}`,
        kind: "comment",
        text: `cached ${index + 1}`,
      }));
      const get = vi.fn().mockResolvedValue(running("stale"));
      const deliver = vi.fn().mockResolvedValue(undefined);
      refreshSignalsMock.mockImplementationOnce(async (input) => {
        expect(input.signals).toHaveLength(4);
        expect(
          pending()?.retryAccounting?.filter((entry) => entry.deliveryAttempts === 0),
        ).toHaveLength(2);
        return input.signals.map((signal) => ({
          status: "failed",
          key: signal.key,
          error: "HTTP 403",
        }));
      });
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      });
      try {
        emit(bus, signals);
        await vi.advanceTimersByTimeAsync(1);
        expect(deliver).not.toHaveBeenCalled();
        expect(pending()?.retryAccounting?.map((entry) => entry.deliveryAttempts)).toEqual([
          1, 1, 1, 1, 0, 0,
        ]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(refreshSignalsMock.mock.calls[1]?.[0].signals.map((signal) => signal.key)).toEqual([
          "comment:5",
          "comment:6",
        ]);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(pending()?.retryAccounting?.map((entry) => entry.deliveryAttempts)).toEqual([
          1, 1, 1, 1,
        ]);
      } finally {
        await controller.stop();
      }
    });

    it.each(["rate_limit", "memory_guard", "cap", "launch_pending", "general"])(
      "refunds only actual submissions on %s, never failed lookups or deletion",
      async (reason) => {
        const signals: ReviewSignal[] = [
          { key: "comment:1", kind: "comment", text: "failed" },
          { key: "comment:2", kind: "comment", text: "gone" },
          { key: "comment:3", kind: "comment", text: "ready" },
          { key: "comment:4", kind: "comment", text: "also ready" },
          { key: "comment:5", kind: "comment", text: "deferred" },
          { key: "ci_failed", kind: "ci_failed", text: "CI failed" },
        ];
        refreshSignalsMock.mockImplementation(async (input) =>
          input.signals.map((signal) =>
            signal.key === "comment:1"
              ? { status: "failed", key: signal.key, error: "HTTP 401" }
              : signal.key === "comment:2"
                ? { status: "deleted", key: signal.key }
                : { status: "live", key: signal.key, signal: { ...signal, text: "current" } },
          ),
        );
        const { startConfiguredTriggers } = await loadTriggersModule();
        const { SessionRateLimitedError, SessionAdmissionDeniedError, LaunchPromptPendingError } =
          await import("../../src/session-service.js");
        const error =
          reason === "rate_limit"
            ? new SessionRateLimitedError("limited")
            : reason === "launch_pending"
              ? new LaunchPromptPendingError("Submit pending", "2026-03-18T10:04:00.000Z")
              : reason === "general"
                ? new Error("uncertain submit")
                : new SessionAdmissionDeniedError(
                    "held",
                    reason === "memory_guard" ? "memory_guard" : "cap",
                  );
        const get = vi.fn().mockResolvedValue(running("interrupt"));
        const deliver = vi.fn().mockRejectedValue(error);
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config: config({ prompt: "review" }) as never,
          bus,
          sessionService: { get, deliver } as never,
          logger: { warn: vi.fn() },
        });
        try {
          emit(bus, signals);
          await vi.advanceTimersByTimeAsync(1);
          const queued = pending();
          if (!queued) throw new Error("Missing queued work");
          queued.admissionCapDenials = 2;
          get.mockResolvedValue(running("stale"));
          await vi.advanceTimersByTimeAsync(5_000);
          expect(deliver.mock.calls[0]?.[1]).toContain("current");
          expect(deliver.mock.calls[0]?.[1]).not.toContain("- failed\n");
          const record = pending();
          expect(record?.batch).toMatchObject({
            signals: signals.filter((signal) => signal.key !== "comment:2"),
          });
          if (reason === "cap") {
            expect(record?.admissionCapRetryAt).toBeGreaterThan(Date.now());
            expect(record?.admissionCapRetryAt).toBeLessThanOrEqual(Date.now() + 40_000);
          } else expect(record?.admissionCapRetryAt).toBeUndefined();
          if (reason === "launch_pending")
            expect(record?.suppressedHoldAt).toBe("2026-03-18T10:04:00.000Z");
          expect(record?.admissionCapDenials).toBe(reason === "cap" ? 3 : 2);
          expect(
            record?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:1")),
          ).toMatchObject({ deliveryAttempts: 1 });
          expect(
            record?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:2")),
          ).toBeUndefined();
          expect(
            record?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:3")),
          ).toMatchObject({ deliveryAttempts: reason === "general" ? 1 : 0 });
          expect(
            record?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:5")),
          ).toMatchObject({ deliveryAttempts: 0, nextAttemptAt: 0 });
          expect(
            record?.retryAccounting?.find((entry) => entry.itemKey.includes("ci_failed")),
          ).toMatchObject({
            deliveryAttempts: reason === "general" ? 1 : 0,
            ciAttempts: reason === "general" ? 1 : 0,
          });
          expect(record?.batch.autoPing?.items["comment:2"]).toBeUndefined();
          expect(record?.batch.autoPing?.items["comment:1"]).toBeTruthy();
          expect(inputLogEntries("api-1")).toHaveLength(0);
          if (reason === "cap") {
            const failed = record?.retryAccounting?.find((entry) =>
              entry.itemKey.includes("comment:1"),
            );
            await vi.advanceTimersByTimeAsync(40_000);
            expect(deliver).toHaveBeenCalledTimes(2);
            expect(
              pending()?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:1")),
            ).toMatchObject({ deliveryAttempts: 2, fingerprint: failed?.fingerprint });
            expect(
              pending()?.retryAccounting?.find((entry) => entry.itemKey.includes("ci_failed")),
            ).toMatchObject({ deliveryAttempts: 0, ciAttempts: 0 });
            expect(pending()?.admissionCapRetryAt).toBeGreaterThan(
              record?.admissionCapRetryAt ?? 0,
            );
            expect(pending()?.admissionCapDenials).toBe(4);
          }
        } finally {
          await controller.stop();
        }
      },
    );

    it("retains failed lookup budgets on restart, overlays live edits without reset, and resets separately enqueued edits", async () => {
      const get = vi.fn().mockResolvedValue(running("stale"));
      const deliver = vi.fn().mockRejectedValue(new Error("uncertain submit"));
      refreshSignalsMock.mockImplementationOnce(async (input) =>
        input.signals.map((signal) => ({ status: "failed", key: signal.key, error: "timeout" })),
      );
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const deps = {
        config: config() as never,
        bus,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      };
      let controller = startConfiguredTriggers(deps);
      const signals: ReviewSignal[] = [{ key: "comment:1", kind: "comment", text: "original" }];
      try {
        emit(bus, signals);
        await vi.advanceTimersByTimeAsync(1);
        const fingerprint = pending()?.retryAccounting?.[0]?.fingerprint;
        await controller.stop();
        controller = startConfiguredTriggers(deps);
        refreshSignalsMock.mockImplementation(async (input) =>
          input.signals.map((signal) => ({
            status: "live",
            key: signal.key,
            signal: { ...signal, text: "edited remotely" },
          })),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pending()?.retryAccounting?.[0]).toMatchObject({ deliveryAttempts: 2, fingerprint });
        expect(pending()?.batch).toMatchObject({ signals });
        emit(
          bus,
          signals.map((signal) => ({ ...signal, text: "separately enqueued edit" })),
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(pending()?.retryAccounting?.[0]?.deliveryAttempts).toBe(1);
        expect(pending()?.retryAccounting?.[0]?.fingerprint).not.toBe(fingerprint);
      } finally {
        await controller.stop();
      }
    });

    const contextChanges = [
      "host",
      "repo",
      "same",
      "URL to repo",
      "repo to URL",
      "matching URL to repo",
      "matching repo to URL",
    ];
    it.each(contextChanges)(
      "admission cap retires absent exhausted accounting and the hold only when the %s context changes",
      async (change) => {
        const dataDir = mkdtempSync(join(tmpdir(), "spur-feedback-context-"));
        const autoPing = new AutoPingService(dataDir);
        const released = vi.spyOn(autoPing, "releaseOccurrenceReference");
        let session: ReturnType<typeof running> & {
          pr?: { number: number; repo: string; url: string };
        } = running("interrupt");
        const get = vi.fn().mockImplementation(async () => session);
        const deliver = vi.fn().mockRejectedValue(new Error("uncertain submit"));
        const { startConfiguredTriggers } = await loadTriggersModule();
        const bus = new EventBus();
        const controller = startConfiguredTriggers({
          config: { ...config(), dataDir } as never,
          bus,
          autoPing,
          sessionService: { get, deliver } as never,
          logger: { warn: vi.fn() },
        });
        const oldEvent = githubEvent("comment:2");
        const old = {
          ...oldEvent,
          data: {
            ...oldEvent.data,
            repo: change.endsWith("URL to repo") ? undefined : oldEvent.data.repo,
            prUrl: change.endsWith("repo to URL") ? undefined : oldEvent.data.prUrl,
          },
        };
        const replaced = change !== "same" && !change.startsWith("matching");
        const partialChange = change === "URL to repo" || change === "repo to URL";
        const incoming = githubEvent();
        const { createSendBatchParser } = await import("../../src/send-batches.js");
        const parsed = createSendBatchParser("github", "api", "pr-watch")(incoming.data);
        const item = parsed?.retryItems()[0];
        if (!item) throw new Error("Missing item fixture");
        try {
          readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot(old.data.signals));
          bus.emit(old);
          await vi.advanceTimersByTimeAsync(1);
          const record = pending();
          if (!record) throw new Error("Missing pending fixture");
          const deadline = Date.now() + 10_000;
          record.admissionCapRetryAt = deadline;
          record.admissionCapDenials = 3;
          record.retryAccounting?.push(
            {
              itemKey: item.itemKey,
              fingerprint: item.fingerprint,
              deliveryAttempts: 8,
              ciAttempts: 0,
              nextAttemptAt: 0,
            },
            {
              itemKey: '["github",420,"comment:1"]',
              fingerprint: item.fingerprint,
              deliveryAttempts: 8,
              ciAttempts: 0,
              nextAttemptAt: 0,
            },
            {
              itemKey: '["gitlab",42,"comment:1"]',
              fingerprint: item.fingerprint,
              deliveryAttempts: 8,
              ciAttempts: 0,
              nextAttemptAt: 0,
            },
          );
          session = running("stale");
          if (replaced) {
            const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
            deliver.mockRejectedValue(new SessionAdmissionDeniedError("full", "cap"));
          }
          if (change === "URL to repo")
            session.pr = {
              number: 42,
              repo: "other/api",
              url: "https://new.example/other/api/pull/42",
            };
          refreshSignalsMock.mockImplementation(async (input) => {
            if (replaced) {
              expect(input.hostname).toBe(
                change === "host" || partialChange ? "new.example" : "github.com",
              );
              expect(input.repo).toBe(
                change === "repo" || partialChange ? "other/api" : "acme/api",
              );
              expect(input.signals.map((signal) => signal.key)).toEqual(["comment:1"]);
              expect(
                pending()?.retryAccounting?.find((entry) => entry.itemKey === item.itemKey)
                  ?.deliveryAttempts,
              ).toBe(1);
            }
            return input.signals.map((signal) => ({
              status: "live",
              key: signal.key,
              signal: { ...signal, text: "current on selected host" },
            }));
          });
          emit(bus, incoming.data.signals, {
            prUrl: change.endsWith("URL to repo")
              ? undefined
              : change === "repo to URL"
                ? "https://new.example/other/api/pull/42"
                : change === "host"
                  ? "https://new.example/acme/api/pull/42"
                  : change === "repo"
                    ? "https://github.com/other/api/pull/42"
                    : incoming.data.prUrl,
            repo: change.endsWith("repo to URL")
              ? undefined
              : change === "repo" || change === "URL to repo"
                ? "other/api"
                : "acme/api",
          });
          if (!replaced)
            readGitHubSourceSnapshotMock.mockReturnValue(
              storedSnapshot([...old.data.signals, ...incoming.data.signals]),
            );
          await vi.advanceTimersByTimeAsync(1);
          const updated = pending();
          expect(updated?.admissionCapDenials).toBe(replaced ? 1 : 3);
          expect(updated?.admissionCapRetryAt).toBe(replaced ? Date.now() + 9_999 : deadline);
          expect(
            updated?.retryAccounting?.filter(
              (entry) =>
                entry.itemKey.startsWith('["github",420,') ||
                entry.itemKey.startsWith('["gitlab",42,'),
            ),
          ).toHaveLength(2);
          if (!replaced) {
            expect(updated?.batch.autoPing?.items["comment:2"]).toBeDefined();
            expect(released).not.toHaveBeenCalledWith(expect.any(String), old.occurrenceId);
            expect(
              updated?.retryAccounting?.find((entry) => entry.itemKey === item.itemKey)
                ?.deliveryAttempts,
            ).toBe(8);
            expect(
              refreshSignalsMock.mock.calls
                .flatMap(([input]) => input.signals)
                .some((signal) => signal.key === "comment:1"),
            ).toBe(false);
          } else {
            expect(deliver.mock.calls[0]?.[1]).toContain("current on selected host");
            expect(updated?.batch.autoPing?.items["comment:2"]).toBeUndefined();
            expect(released).toHaveBeenCalledWith(expect.any(String), old.occurrenceId);
            expect(
              updated?.retryAccounting?.find((entry) => entry.itemKey.includes("comment:2")),
            ).toBeUndefined();
          }
        } finally {
          await controller.stop();
          autoPing.dispose();
          rmSync(dataDir, { recursive: true, force: true });
        }
      },
    );

    it("persists failed-only attempts across reload until bound8 while preserving CI's independent3 reminders", async () => {
      const get = vi.fn().mockResolvedValue(running("stale"));
      const deliver = vi.fn().mockResolvedValue(undefined);
      refreshSignalsMock.mockImplementation(async (input) =>
        input.signals.map((signal) => ({ status: "failed", key: signal.key, error: "HTTP 403" })),
      );
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const deps = {
        config: config() as never,
        bus,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      };
      let controller = startConfiguredTriggers(deps);
      const signals: ReviewSignal[] = [
        { key: "comment:1", kind: "comment", text: "original" },
        { key: "ci_failed", kind: "ci_failed", text: "CI failed" },
      ];
      try {
        emit(bus, signals);
        await vi.advanceTimersByTimeAsync(1);
        expect(
          pending()?.retryAccounting?.find((entry) => entry.itemKey.includes("ci_failed")),
        ).toMatchObject({ ciAttempts: 1, deliveryAttempts: 1 });
        await controller.stop();
        controller = startConfiguredTriggers(deps);
        for (let attempt = 1; attempt < 8; attempt += 1) {
          await vi.advanceTimersByTimeAsync(10_000 * 2 ** (attempt - 1) + 5_000);
        }
        expect(refreshSignalsMock).toHaveBeenCalledTimes(8);
        expect(deliver).toHaveBeenCalledTimes(3);
        expect(deliver.mock.calls.every((call) => !String(call[1]).includes("original"))).toBe(
          true,
        );
        expect(pending()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(refreshSignalsMock).toHaveBeenCalledTimes(8);
      } finally {
        await controller.stop();
      }
    });

    it("charges missing legacy identity durably without invoking the provider", async () => {
      const get = vi.fn().mockResolvedValue(running("stale"));
      const deliver = vi.fn().mockResolvedValue(undefined);
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      });
      try {
        const event = githubEvent();
        const { prUrl: _url, ...legacy } = event.data;
        readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot(legacy.signals));
        bus.emit({ ...event, data: legacy });
        await vi.advanceTimersByTimeAsync(1);
        expect(pending()?.retryAccounting?.[0]).toMatchObject({
          deliveryAttempts: 1,
          ciAttempts: 0,
        });
        expect(refreshSignalsMock).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pending()?.retryAccounting?.[0]?.deliveryAttempts).toBe(2);
        expect(refreshSignalsMock).not.toHaveBeenCalled();
      } finally {
        await controller.stop();
      }
    });

    it("makes no merge-conflict claim or input event when live feedback is all deleted", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "spur-feedback-delete-"));
      const autoPing = new AutoPingService(dataDir);
      const claim = vi.spyOn(autoPing, "claimMergeConflict");
      const get = vi.fn().mockResolvedValue(running("stale"));
      const deliver = vi.fn().mockResolvedValue(undefined);
      refreshSignalsMock.mockImplementation(async (input) =>
        input.signals.map((signal) => ({ status: "deleted", key: signal.key })),
      );
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: { ...config({ prompt: "review" }), dataDir } as never,
        bus,
        autoPing,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      });
      try {
        emit(bus, githubEvent().data.signals);
        await vi.advanceTimersByTimeAsync(1);
        expect(pending()).toBeUndefined();
        expect(deliver).not.toHaveBeenCalled();
        expect(claim).not.toHaveBeenCalled();
        expect(inputLogEntries("api-1")).toHaveLength(0);
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
          "trigger.send.dropped",
        );
      } finally {
        await controller.stop();
        autoPing.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("keeps unsubscribe behind locked refresh then suppresses the failed delivery's queued feedback", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "spur-feedback-order-"));
      const autoPing = new AutoPingService(dataDir);
      const get = vi.fn().mockResolvedValue(running("stale"));
      const deliver = vi.fn().mockRejectedValue(new Error("uncertain submit"));
      let release = (_results: ReviewSignalRefreshResult[]): void => {};
      let entered = (): void => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      refreshSignalsMock.mockImplementationOnce(async () => {
        entered();
        return new Promise<ReviewSignalRefreshResult[]>((resolve) => {
          release = resolve;
        });
      });
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: { ...config(), dataDir } as never,
        bus,
        autoPing,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      });
      try {
        emit(bus, githubEvent().data.signals);
        const advancing = vi.advanceTimersByTimeAsync(1);
        await started;
        const handle = pending()?.batch.autoPing?.items["comment:1"]?.eventHandle;
        if (!handle) throw new Error("Missing unsubscribe handle");
        let unsubscribed = false;
        const unsubscribe = autoPing.unsubscribe("api-1", "event", handle).then(() => {
          unsubscribed = true;
        });
        await Promise.resolve();
        expect(unsubscribed).toBe(false);
        release([
          {
            status: "live",
            key: "comment:1",
            signal: { key: "comment:1", kind: "comment", text: "current" },
          },
        ]);
        await advancing;
        await unsubscribe;
        expect(unsubscribed).toBe(true);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(refreshSignalsMock).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        release([]);
        await controller.stop();
        autoPing.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
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

  it("prunes the authoritative claimed payload and releases reload occurrence references", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-trigger-gc-"));
    const autoPing = new AutoPingService(dataDir);
    const get = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "working",
      workspaceExists: true,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const deps = {
      config: { ...config(), dataDir } as never,
      bus,
      autoPing,
      sessionService: { get, deliver } as never,
      logger: { warn: vi.fn() },
    };
    let controller = startConfiguredTriggers(deps);
    try {
      bus.emit(githubEvent());
      bus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [{ key: "comment:2", kind: "comment", text: "Live comment." }],
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot("comment:2"));
      await controller.stop();
      controller = startConfiguredTriggers(deps);
      get.mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
      await advanceSendWindow();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[1]).toContain("Live comment.");
      expect(deliver.mock.calls[0]?.[1]).not.toContain("A new comment arrived.");
      const suffix = String(deliver.mock.calls[0]?.[2]?.sensitivePromptSuffix);
      const handle = suffix.match(/comment:2 event:.*--event (ap1_[A-Za-z0-9_-]{43})/)?.[1];
      expect(handle).toBeDefined();
      await autoPing.unsubscribe("api-1", "event", handle ?? "");
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
      autoPing.gc();
      expect(autoPing.list("api-1")).toEqual([]);
    } finally {
      await controller.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("caps fresh conflict envelopes across controllers while delivering new sibling comments", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-conflict-cap-"));
    const autoPing = new AutoPingService(dataDir);
    const bus = new EventBus();
    const get = vi.fn().mockResolvedValue({
      id: "api-1",
      state: "stale",
      status: "stopped",
      workspaceExists: true,
      stopReason: "stale_timeout",
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const deps = {
      config: { ...config({ event: "github:merge_conflict" }), dataDir } as never,
      bus,
      autoPing,
      sessionService: { get, deliver } as never,
      logger: { warn: vi.fn() },
    };
    let controller = startConfiguredTriggers(deps);
    try {
      for (let index = 0; index < 100; index += 1) {
        const event = mergeConflictEvent();
        const signals = [
          ...event.data.signals,
          { key: `comment:${index}`, kind: "comment" as const, text: `Action ${index}` },
        ];
        readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot(signals));
        bus.emit({ ...event, occurrenceId: `fresh-${index}`, data: { ...event.data, signals } });
        await vi.advanceTimersByTimeAsync(1);
        await controller.stop();
        controller = startConfiguredTriggers(deps);
      }
      expect(deliver).toHaveBeenCalledTimes(100);
      expect(
        deliver.mock.calls.filter((call) =>
          String(call[1]).includes("Merge conflicts are blocking"),
        ),
      ).toHaveLength(3);
      expect(deliver.mock.calls.at(-1)?.[1]).toContain("Action 99");
    } finally {
      await controller.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "retains exhausted item tombstones across fresh UUIDs and reloads (CI=%s)",
    async (ci) => {
      const dataDir = mkdtempSync(join(tmpdir(), "spur-item-budget-"));
      const autoPing = new AutoPingService(dataDir);
      const bus = new EventBus();
      const get = vi.fn().mockResolvedValue({
        id: "api-1",
        state: ci ? "working" : "stale",
        status: ci ? "running" : "stopped",
        stopReason: "stale_timeout",
        workspaceExists: true,
      });
      const deliver = ci
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn().mockRejectedValue(new Error("uncertain submit"));
      const { startConfiguredTriggers } = await loadTriggersModule();
      const event = ci ? ciFailedEvent() : githubEvent();
      const deps = {
        config: { ...config({ event: event.name, interrupt: ci }), dataDir } as never,
        bus,
        autoPing,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      };
      let controller = startConfiguredTriggers(deps);
      const limit = ci ? 3 : 8;
      const delay = (attempt: number): number => (ci ? 600_000 : 10_000 * 2 ** (attempt - 1));
      try {
        readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot(event.data.signals));
        bus.emit(event);
        await vi.advanceTimersByTimeAsync(1);
        for (let attempt = 1; attempt < limit - 1; attempt += 1)
          await vi.advanceTimersByTimeAsync(delay(attempt) + 5_000);
        expect(deliver).toHaveBeenCalledTimes(limit - 1);
        const first = event.data.signals[0];
        if (!first) throw new Error("missing fixture signal");
        const sibling = { ...first, key: "sibling", text: "Independent sibling" };
        readGitHubSourceSnapshotMock.mockReturnValue(
          storedSnapshot([...event.data.signals, sibling]),
        );
        bus.emit({
          ...event,
          occurrenceId: "new-sibling",
          data: { ...event.data, signals: [sibling] },
        });
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(delay(limit - 1));
        for (let index = 0; index < 100; index += 1) {
          await controller.stop();
          controller = startConfiguredTriggers(deps);
          bus.emit({ ...event, occurrenceId: `new-envelope-${index}` });
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(
          deliver.mock.calls.filter((call) => String(call[1]).includes(first.text)),
        ).toHaveLength(limit);
        const record = readPendingSendBatchesMock().get("api:send:api-1") as PersistedPendingBatch;
        expect(
          record.retryAccounting?.find((entry) => entry.itemKey.includes(first.key)),
        ).toMatchObject({ deliveryAttempts: limit, ciAttempts: ci ? limit : 0 });
        const changed = { ...first, text: "Changed actionable item" };
        readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot([changed, sibling]));
        bus.emit({
          ...event,
          occurrenceId: "changed-envelope",
          data: { ...event.data, signals: [changed] },
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(deliver.mock.calls.at(-1)?.[1]).toContain("Changed actionable item");
        expect(deliver.mock.calls.at(-1)?.[1]).not.toContain(first.text);
      } finally {
        await controller.stop();
        autoPing.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("re-reads a sibling merged while the old controller waits for session state and reserves before submission", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-item-race-"));
    const autoPing = new AutoPingService(dataDir);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const working = { id: "api-1", status: "running", state: "working", workspaceExists: true };
    const get = vi
      .fn()
      .mockResolvedValueOnce(working)
      .mockImplementation(async () => {
        markStarted();
        await held;
        return { ...working, state: "waiting", lastActivityAt: staleActivity() };
      });
    const deliver = vi.fn().mockImplementation(async () => {
      const record = readPendingSendBatchesMock().get("api:send:api-1") as PersistedPendingBatch;
      expect(
        record.retryAccounting?.find((entry) => entry.itemKey.includes("comment:2")),
      ).toMatchObject({ deliveryAttempts: 1 });
    });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const deps = {
      config: { ...config(), dataDir } as never,
      bus,
      autoPing,
      sessionService: { get, deliver } as never,
      logger: { warn: vi.fn() },
    };
    const old = startConfiguredTriggers(deps);
    let replacement: ReturnType<typeof startConfiguredTriggers> | undefined;
    try {
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
      bus.emit(githubEvent());
      await vi.advanceTimersByTimeAsync(1);
      const ticking = vi.advanceTimersByTimeAsync(35_000);
      await started;
      const replacementBus = new EventBus();
      replacement = startConfiguredTriggers({
        ...deps,
        bus: replacementBus,
        sessionService: { get: vi.fn().mockResolvedValue(working), deliver } as never,
      });
      replacementBus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [{ key: "comment:2", kind: "comment", text: "Concurrent live sibling" }],
        },
      });
      await vi.waitFor(() => expect(recordPendingSendBatchMock).toHaveBeenCalledTimes(2));
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot("comment:2"));
      release();
      await ticking;
      await advanceSendWindow();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[1]).toContain("Concurrent live sibling");
      expect(deliver.mock.calls[0]?.[1]).not.toContain("A new comment arrived.");
    } finally {
      release();
      await old.stop();
      await replacement?.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("delivers later GitLab conflict episodes after three successful notifications", async () => {
    const settings = gitlabConfig();
    settings.projects.api.triggers.send.event = "gitlab:merge_conflict";
    const get = vi.fn().mockResolvedValue({
      id: "api-1",
      state: "stale",
      status: "stopped",
      stopReason: "stale_timeout",
      workspaceExists: true,
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: settings as never,
      bus,
      sessionService: { get, deliver } as never,
      logger: { warn: vi.fn() },
    });
    try {
      const signals: ReviewSignal[] = [
        { key: "merge_conflict", kind: "merge_conflict", text: "Merge request conflicts" },
      ];
      readReviewSourceSnapshotMock.mockReturnValue(storedSnapshot(signals));
      for (let index = 0; index < 5; index += 1) {
        bus.emit({
          ...gitlabEvent(),
          name: "gitlab:merge_conflict",
          occurrenceId: `episode-${index}`,
          data: { ...gitlabEvent().data, signals },
        });
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(deliver).toHaveBeenCalledTimes(5);
    } finally {
      await controller.stop();
    }
  });

  it("suppresses a retried occurrence after its recipient redeems the event grant", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-trigger-auto-ping-"));
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const autoPing = new AutoPingService(dataDir);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: { ...config(), dataDir } as never,
      bus,
      sessionService: { get: getMock, deliver: deliverMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    });
    try {
      bus.emit({ ...githubEvent(), occurrenceId: "same-occurrence" });
      await advanceSendWindow();
      const suffix = (
        deliverMock.mock.calls[0]?.[2] as { sensitivePromptSuffix?: string } | undefined
      )?.sensitivePromptSuffix;
      const handle = suffix?.match(/--event (ap1_[A-Za-z0-9_-]{43})/)?.[1];
      expect(handle).toBeDefined();
      await autoPing.unsubscribe("api-1", "event", handle ?? "");
      deliverMock.mockClear();

      bus.emit({ ...githubEvent(), occurrenceId: "same-occurrence" });
      await advanceSendWindow();
      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("lets a replacement re-read a completed claimed batch without a second delivery", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-trigger-reload-"));
    const autoPing = new AutoPingService(dataDir);
    let releaseDelivery!: () => void;
    const deliverStarted = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const deliverMock = vi.fn().mockImplementation(async () => {
      markStarted();
      await deliverStarted;
    });
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const deps = {
      config: { ...config(), dataDir } as never,
      bus,
      sessionService: { get: getMock, deliver: deliverMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    };
    const oldController = startConfiguredTriggers(deps);
    let replacement: ReturnType<typeof startConfiguredTriggers> | undefined;
    try {
      bus.emit(githubEvent());
      const advancing = vi.advanceTimersByTimeAsync(35_000);
      await started;
      const replacementBus = new EventBus();
      replacement = startConfiguredTriggers({ ...deps, bus: replacementBus });
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot("comment:2"));
      replacementBus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [
            {
              key: "comment:2",
              kind: "comment",
              text: "Only the replacement event.",
            },
          ],
        },
      });
      releaseDelivery();
      await advancing;
      await vi.advanceTimersByTimeAsync(35_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(deliverMock.mock.calls[1]?.[1]).toContain("Only the replacement event.");
      expect(deliverMock.mock.calls[1]?.[1]).not.toContain("A new comment arrived.");
    } finally {
      releaseDelivery();
      await oldController.stop();
      await replacement?.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("delivers a replacement live event once after an old-controller retry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-trigger-retry-reload-"));
    const autoPing = new AutoPingService(dataDir);
    let releaseDelivery!: () => void;
    const heldDelivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const deliverMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        markStarted();
        await heldDelivery;
        throw new Error("retry old delivery");
      })
      .mockResolvedValue(undefined);
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const oldBus = new EventBus();
    const deps = {
      config: { ...config(), dataDir } as never,
      bus: oldBus,
      sessionService: { get: getMock, deliver: deliverMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    };
    const oldController = startConfiguredTriggers(deps);
    let replacement: ReturnType<typeof startConfiguredTriggers> | undefined;
    try {
      oldBus.emit(githubEvent());
      const advancing = vi.advanceTimersByTimeAsync(35_000);
      await started;
      const replacementBus = new EventBus();
      replacement = startConfiguredTriggers({ ...deps, bus: replacementBus });
      readGitHubSourceSnapshotMock.mockReturnValue(
        storedSnapshot([
          { key: "comment:1", kind: "comment", text: "A new comment arrived." },
          { key: "comment:2", kind: "comment", text: "Replacement live event." },
        ]),
      );
      replacementBus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [
            {
              key: "comment:2",
              kind: "comment",
              text: "Replacement live event.",
            },
          ],
        },
      });
      releaseDelivery();
      await advancing;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(deliverMock).toHaveBeenCalledTimes(3);
      expect(deliverMock.mock.calls[1]?.[1]).not.toContain("A new comment arrived.");
      expect(deliverMock.mock.calls[1]?.[1]).toContain("Replacement live event.");
      expect(deliverMock.mock.calls[2]?.[1]).toContain("A new comment arrived.");
      expect(deliverMock.mock.calls[2]?.[1]).not.toContain("Replacement live event.");
      expect(
        deliverMock.mock.calls.filter((call) =>
          String(call[1]).includes("Replacement live event."),
        ),
      ).toHaveLength(1);
    } finally {
      releaseDelivery();
      await oldController.stop();
      await replacement?.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not let a stale controller overwrite replacement work", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-trigger-work-replaced-"));
    const autoPing = new AutoPingService(dataDir);
    let sessionState: "working" | "stale" = "working";
    const getMock = vi.fn().mockImplementation(async () => ({
      id: "api-1",
      status: sessionState === "stale" ? "stopped" : "running",
      state: sessionState,
      ...(sessionState === "stale" ? { stopReason: "stale_timeout" } : {}),
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    }));
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const oldBus = new EventBus();
    const deps = {
      config: { ...config(), dataDir } as never,
      bus: oldBus,
      sessionService: { get: getMock, deliver: deliverMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    };
    const oldController = startConfiguredTriggers(deps);
    let replacement: ReturnType<typeof startConfiguredTriggers> | undefined;
    let deliveryController: ReturnType<typeof startConfiguredTriggers> | undefined;
    try {
      oldBus.emit(githubEvent());
      await vi.advanceTimersByTimeAsync(1);
      const records = readPendingSendBatchesMock();
      const firstWorkId = records.values().next().value?.workId;
      expect(firstWorkId).toBeDefined();

      const replacementBus = new EventBus();
      replacement = startConfiguredTriggers({ ...deps, bus: replacementBus });
      records.clear();
      replacementBus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [
            {
              key: "comment:2",
              kind: "comment",
              text: "Replacement work survives.",
            },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      const replacementWorkId = records.values().next().value?.workId;
      expect(replacementWorkId).toBeDefined();
      expect(replacementWorkId).not.toBe(firstWorkId);

      oldBus.emit({
        ...githubEvent("comment:3"),
        data: {
          ...githubEvent("comment:3").data,
          signals: [{ key: "comment:3", kind: "comment", text: "Delayed stale event." }],
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(records.values().next().value?.workId).toBe(replacementWorkId);

      readGitHubSourceSnapshotMock.mockReturnValue(
        storedSnapshot([{ key: "comment:2", kind: "comment", text: "Replacement work survives." }]),
      );
      sessionState = "stale";
      const deliveryBus = new EventBus();
      deliveryController = startConfiguredTriggers({ ...deps, bus: deliveryBus });
      deliveryBus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [
            {
              key: "comment:2",
              kind: "comment",
              text: "Replacement work survives.",
            },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(deliverMock).toHaveBeenCalledOnce();
      expect(deliverMock.mock.calls[0]?.[1]).toContain("Replacement work survives.");
      expect(deliverMock.mock.calls[0]?.[1]).not.toContain("Delayed stale event.");
    } finally {
      await oldController.stop();
      await replacement?.stop();
      await deliveryController?.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps replacement work when a stale controller drops its own batch", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "spur-trigger-stale-drop-"));
    const autoPing = new AutoPingService(dataDir);
    let staleLookupFails = false;
    const staleGetMock = vi.fn().mockImplementation(async () => {
      if (staleLookupFails) throw new Error("session lookup failed");
      return {
        id: "api-1",
        status: "running",
        state: "working",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      };
    });
    const replacementGetMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "rate_limited",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
    readGitHubSourceSnapshotMock.mockReturnValue(
      storedSnapshot([
        { key: "comment:1", kind: "comment", text: "A new comment arrived." },
        { key: "comment:2", kind: "comment", text: "Replacement work survives." },
      ]),
    );
    const { startConfiguredTriggers } = await loadTriggersModule();
    const staleBus = new EventBus();
    const deps = {
      config: { ...config(), dataDir } as never,
      bus: staleBus,
      sessionService: { get: staleGetMock, deliver: deliverMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    };
    const staleController = startConfiguredTriggers(deps);
    let replacement: ReturnType<typeof startConfiguredTriggers> | undefined;
    try {
      staleBus.emit(githubEvent());
      await vi.advanceTimersByTimeAsync(1);
      const records = readPendingSendBatchesMock();
      const staleWorkId = records.values().next().value?.workId;
      expect(staleWorkId).toBeDefined();

      // A replacement controller only claims the queue key once it is free.
      records.clear();
      const replacementBus = new EventBus();
      replacement = startConfiguredTriggers({
        ...deps,
        bus: replacementBus,
        sessionService: { get: replacementGetMock, deliver: deliverMock } as never,
      });
      replacementBus.emit({
        ...githubEvent("comment:2"),
        data: {
          ...githubEvent("comment:2").data,
          signals: [{ key: "comment:2", kind: "comment", text: "Replacement work survives." }],
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      const replacementWorkId = records.values().next().value?.workId;
      expect(replacementWorkId).toBeDefined();
      expect(replacementWorkId).not.toBe(staleWorkId);

      // The stale controller now drops its own batch. Deleting by queue key
      // would take the replacement's persisted record with it.
      staleLookupFails = true;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(records.size).toBe(1);
      expect(records.values().next().value?.workId).toBe(replacementWorkId);
      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      await staleController.stop();
      await replacement?.stop();
      autoPing.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("delivers GitHub updates immediately to a stale-parked session with no idle wait", async () => {
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "stopped",
      stopReason: "stale_timeout",
      state: "stale",
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

  it("retains the first-arrival deadline when a second event merges into the same queue key", async () => {
    const secondEvent = {
      name: "github:comment",
      occurrenceId: "github-comment-2",
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

  it("opens no backoff when the delivery raced a teardown, so the batch flushes as soon as the session is back", async () => {
    let state: "waiting" | "stopped" = "waiting";
    const getMock = vi.fn().mockImplementation(async () => ({
      id: "api-1",
      status: state === "stopped" ? "stopped" : "running",
      state,
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    }));
    // The pane dies mid-flight: the send fails and the session reads stopped
    // right after, exactly as a pause/restore teardown leaves it.
    const deliverMock = vi.fn().mockImplementation(async () => {
      state = "stopped";
      throw new Error("can't find session: api-1");
    });
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
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalledTimes(1);
      });

      // Restored before the next flush tick. A backoff would hold the batch
      // for 10s; without one the very next tick delivers.
      state = "waiting";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(deliverMock).toHaveBeenCalledTimes(2);
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

  // Regression fence, NOT mutation-checked: this file injects a stub
  // sessionService ({ get, deliver } as never at :1188), so deliver() here
  // is a bare vi.fn() that never runs sendDeferredSensitiveInitialMessage
  // (session-service.ts). It cannot prove the fix — see
  // deferred-controls-ack.test.ts for that. It only pins triggers.ts's own
  // contract: once deliver() resolves (which is what a live-agent controls
  // ack timeout now does, instead of throwing), the batch is treated as
  // delivered — no drop event, no retry — matching the success path at
  // triggers.ts:1034-1037.
  it("treats a resolved deliver() as delivered with no retry (controls-ack-timeout success shape)", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    const deliverMock = vi.fn().mockResolvedValue(undefined);
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
      const dropped = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .find((entry) => entry.event === "trigger.send.dropped");
      expect(dropped).toBeUndefined();

      // No backoff opened on success: an hour of further ticks re-attempts nothing.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(deliverMock).toHaveBeenCalledTimes(1);
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

  it("renders webhook body and received time into one spawn", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-webhook" });
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: webhookSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(webhookEvent());
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalledWith({
          project: "api",
          prompt: 'Body={"kind":"deploy"} At=2026-09-08T12:00:00.000Z',
        });
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
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
          reasoningEffort: "xhigh",
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

  it("promotes the next desk-group block to anchor when the anchor spawn fails", async () => {
    const spawnMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("anchor failed"))
      .mockResolvedValueOnce({ id: "api-8" })
      .mockResolvedValueOnce({ id: "api-9" });
    const warnMock = vi.fn();
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: spawnDeskGroupConfig({ thirdBlock: true }) as never,
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
        expect(spawnMock).toHaveBeenCalledTimes(3);
      });
      expect(warnMock).toHaveBeenCalledWith(
        "[trigger:api/kickoff] failed to spawn claude: anchor failed",
      );
      expect(warnMock).toHaveBeenCalledWith(
        "[trigger:api/kickoff] promoting spawn block 1 to desk anchor: earlier anchor spawn failed",
      );
      expect(spawnMock.mock.calls[1]?.[0]).not.toHaveProperty("reuseWorkspaceSessionId");
      expect(spawnMock.mock.calls[2]?.[0]).toMatchObject({
        agent: "cursor",
        reuseWorkspaceSessionId: "api-8",
      });
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
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
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
    readGitHubSourceSnapshotMock.mockReturnValue(storedSnapshot(mergeConflictEvent().data.signals));
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

  it("lets a block opt out of a spawn-level restrictWrites default", async () => {
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
                  restrictWrites: true,
                  blocks: [
                    { prompt: "review only" },
                    { prompt: "write access", restrictWrites: false },
                  ],
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
        expect(spawnMock).toHaveBeenCalledTimes(2);
      });
      expect(spawnMock).toHaveBeenNthCalledWith(1, {
        project: "api",
        prompt: "review only",
        restrictWrites: true,
      });
      expect(spawnMock).toHaveBeenNthCalledWith(2, {
        project: "api",
        prompt: "write access",
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

  it("delivers send triggers listed in the session allowlist", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
      allowedTriggers: ["send"],
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
      await vi.waitFor(() => {
        expect(deliverMock).toHaveBeenCalled();
      });
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

  it("spawns a work item without auto-ping controls", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const policyDir = mkdtempSync(join(tmpdir(), "spur-work-item-policy-"));
    const autoPing = new AutoPingService(policyDir);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      expect(spawnMock.mock.calls[0]).toHaveLength(1);
      const path = join(policyDir, "auto-ping.json");
      const grants = existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as { grants: unknown[] }).grants
        : [];
      expect(grants).toHaveLength(0);
    } finally {
      await controller.stop();
      autoPing.dispose();
      rmSync(policyDir, { recursive: true, force: true });
    }
  });

  it("legacy trigger-destination subscription no longer mutes spawns", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const policyDir = mkdtempSync(join(tmpdir(), "spur-work-item-policy-"));
    const legacyDescriptor = {
      version: 1,
      projectId: "api",
      triggerId: "pick-up",
      sourceId: "pr-watch",
      sourceType: "github",
      eventName: "github:work_item.new",
      actionKind: "spawn",
      destination: { kind: "trigger" },
      spawnDeskGroup: false,
    };
    const fingerprint = autoPingRouteFingerprint(
      legacyDescriptor as unknown as AutoPingRouteDescriptor,
    );
    const now = new Date().toISOString();
    writeFileSync(
      join(policyDir, "auto-ping.json"),
      JSON.stringify({
        version: 1,
        routes: [{ routeFingerprint: fingerprint, descriptor: legacyDescriptor }],
        grants: [],
        suppressions: [
          {
            suppressionId: "legacy-suppression",
            scope: "subscription",
            routeFingerprint: fingerprint,
            destination: { kind: "trigger" },
            target: { kind: "subscription" },
            canonicalKey: "legacy-key",
            actorSessionId: "owner",
            createdAt: now,
          },
        ],
        mergeConflicts: [],
      }),
    );
    const autoPing = new AutoPingService(policyDir);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      expect(spawnMock.mock.calls[0]).toHaveLength(1);
    } finally {
      await controller.stop();
      autoPing.dispose();
      rmSync(policyDir, { recursive: true, force: true });
    }
  });

  it("spawn triggers never consult auto-ping suppression", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-9" });
    const policyDir = mkdtempSync(join(tmpdir(), "spur-work-item-policy-"));
    const autoPing = new AutoPingService(policyDir);
    const isSuppressedSpy = vi.spyOn(autoPing, "isSuppressed").mockReturnValue(true);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { spawn: spawnMock } as never,
      autoPing,
      logger: { warn: vi.fn() },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      expect(isSuppressedSpy).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      autoPing.dispose();
      rmSync(policyDir, { recursive: true, force: true });
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

  it.each([
    {
      reason: "work_item_pending",
      level: "info",
      lifecycle: { ...runningWorkItemLifecycle(), state: "pending" as const, sessionId: undefined },
      get: undefined,
    },
    {
      reason: "work_item_completed",
      level: "info",
      lifecycle: {
        ...runningWorkItemLifecycle(),
        state: "completed" as const,
        completedAt: new Date().toISOString(),
      },
      get: undefined,
    },
    {
      reason: "owner_completed",
      level: "info",
      lifecycle: runningWorkItemLifecycle(),
      get: {
        id: "api-9",
        status: "completed" as const,
        state: "waiting" as const,
        workspaceExists: true,
      },
    },
    {
      reason: "owner_active",
      level: "info",
      lifecycle: runningWorkItemLifecycle(),
      get: {
        id: "api-9",
        status: "running" as const,
        state: "needs_input" as const,
        workspaceExists: true,
      },
    },
    {
      reason: "owner_not_replaceable",
      level: "info",
      lifecycle: runningWorkItemLifecycle(),
      get: {
        id: "api-9",
        status: "running" as const,
        state: "rate_limited" as const,
        workspaceExists: true,
      },
    },
  ])("logs the suppression reason: $reason", async ({ reason, level, lifecycle, get }) => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-10" });
    const getMock = get ? vi.fn().mockResolvedValue(get) : vi.fn();
    useWorkItemLifecycleStore([lifecycle as unknown as WorkItemLifecycleRecord]);
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
        expect(
          logSpurEventMock.mock.calls
            .map(([, entry]) => entry)
            .filter((entry) => entry.event === "trigger.spawn.suppressed"),
        ).toHaveLength(1);
      });
      expect(spawnMock).not.toHaveBeenCalled();
      const [, entry] = logSpurEventMock.mock.calls.find(
        ([, e]) => e.event === "trigger.spawn.suppressed",
      ) as [string, { level: string; details: { reason: string } }];
      expect(entry.level).toBe(level);
      expect(entry.details.reason).toBe(reason);
    } finally {
      await controller.stop();
    }
  });

  it("logs owner_load_failed with the underlying error at warn level", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-10" });
    const getMock = vi.fn().mockRejectedValue(new Error("boom"));
    const warnMock = vi.fn();
    useWorkItemLifecycleStore([runningWorkItemLifecycle()]);
    const { startConfiguredTriggers } = await loadTriggersModule();
    const bus = new EventBus();
    const controller = startConfiguredTriggers({
      config: workItemSpawnConfig() as never,
      bus,
      sessionService: { get: getMock, spawn: spawnMock } as never,
      logger: { warn: warnMock },
    });

    try {
      bus.emit(workItemEvent());
      await vi.waitFor(() => {
        expect(
          logSpurEventMock.mock.calls
            .map(([, entry]) => entry)
            .filter((entry) => entry.event === "trigger.spawn.suppressed"),
        ).toHaveLength(1);
      });
      expect(spawnMock).not.toHaveBeenCalled();
      const [, entry] = logSpurEventMock.mock.calls.find(
        ([, e]) => e.event === "trigger.spawn.suppressed",
      ) as [string, { level: string; details: { reason: string; error?: string } }];
      expect(entry.level).toBe("warn");
      expect(entry.details.reason).toBe("owner_load_failed");
      expect(entry.details.error).toBe("boom");
      expect(warnMock).toHaveBeenCalledWith(
        expect.stringContaining("suppressed work item acme/api#42: boom"),
      );
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

  it("never spawns a second session for a stale-parked work-item owner (still owns the work, wakes silently instead)", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ id: "api-10" });
    const getMock = vi.fn().mockResolvedValue({
      id: "api-9",
      status: "stopped",
      stopReason: "stale_timeout",
      state: "stale",
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
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).not.toHaveBeenCalled();
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

  it("clears the work item when auto-complete hits a SessionResourceNotFoundError", async () => {
    // Dynamic import so the error class comes from the same session-service.js
    // module instance triggers.ts uses. isSessionNotFoundError matches on
    // .message, so this pins that the typed class preserves the message text
    // of the converted `Session not found:` throws.
    const { SessionResourceNotFoundError } = await import("../../src/session-service.js");
    const getMock = vi.fn().mockResolvedValue({
      id: "api-9",
      status: "running",
      state: "waiting",
      workspaceExists: true,
    });
    const completeMock = vi
      .fn()
      .mockRejectedValue(new SessionResourceNotFoundError("Session not found: api-9"));
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
        expect(deleteWorkItemLifecycleMock).toHaveBeenCalledWith(
          DATA_DIR,
          "api",
          "pr-watch",
          "acme/api#42",
        );
      });
      expect(logSpurEventMock).toHaveBeenCalledWith(
        DATA_DIR,
        expect.objectContaining({
          event: "trigger.work_item_auto_complete.noop",
          level: "info",
        }),
      );
      expect(logSpurEventMock).not.toHaveBeenCalledWith(
        DATA_DIR,
        expect.objectContaining({ event: "trigger.work_item_auto_complete.failed" }),
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
      expect(deletePendingSendBatchConditionalMock).toHaveBeenCalledWith(
        DATA_DIR,
        expect.objectContaining({ workId: expect.any(String), claimId: expect.any(String) }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("suppresses a delivery refused over a pending launch prompt without spending an attempt", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const { LaunchPromptPendingError } = await import("../../src/session-service.js");
    const deliverMock = vi
      .fn()
      .mockRejectedValue(new LaunchPromptPendingError("Agent has not confirmed the launch prompt"));
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
      const events = logSpurEventMock.mock.calls.map(([, entry]) => entry.event);
      expect(events).toContain("trigger.send.suppressed_launch_pending");
      expect(events).not.toContain("trigger.send.failed");
      const record = readPendingSendBatchesMock().get("api:send:api-1") as PersistedPendingBatch;
      expect(record.retryAccounting?.every((entry) => entry.deliveryAttempts === 0)).toBe(true);
    } finally {
      await controller.stop();
    }
  });

  it("logs a launch-pending suppression once per hold across flush ticks and a restart", async () => {
    const getMock = vi.fn().mockResolvedValue({
      id: "api-1",
      status: "running",
      state: "waiting",
      lastActivityAt: staleActivity(),
      workspaceExists: true,
    });
    readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
    const { startConfiguredTriggers } = await loadTriggersModule();
    const { LaunchPromptPendingError } = await import("../../src/session-service.js");
    let holdAt = "2026-03-18T10:04:00.000Z";
    const deliverMock = vi.fn(async () => {
      throw new LaunchPromptPendingError("Agent has not confirmed the last prompt", holdAt);
    });
    const deps = {
      config: config() as never,
      sessionService: { get: getMock, deliver: deliverMock } as never,
      logger: { warn: vi.fn() },
    };
    const suppressions = (): number =>
      logSpurEventMock.mock.calls.filter(
        ([, entry]) => entry.event === "trigger.send.suppressed_launch_pending",
      ).length;
    const bus = new EventBus();
    let controller = startConfiguredTriggers({ ...deps, bus });

    try {
      bus.emit(githubEvent());
      await vi.advanceTimersByTimeAsync(30_001);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliverMock.mock.calls.length).toBeGreaterThan(3);
      expect(suppressions()).toBe(1);

      // Daemon restart: the persisted batch still names the logged hold.
      await controller.stop();
      const callsBeforeRestart = deliverMock.mock.calls.length;
      controller = startConfiguredTriggers({ ...deps, bus: new EventBus() });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(deliverMock.mock.calls.length).toBeGreaterThan(callsBeforeRestart);
      expect(suppressions()).toBe(1);

      // A new hold is a new instance: logged once more.
      holdAt = "2026-03-18T10:30:00.000Z";
      await vi.advanceTimersByTimeAsync(60_000);
      expect(suppressions()).toBe(2);
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
        prUrl: "https://github.com/acme/api/pull/42",
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

  it.each(["event", "source", "destination", "malformed"])(
    "rejects persisted route authority changed at %s",
    async (change) => {
      const dataDir = mkdtempSync(join(tmpdir(), "spur-route-change-"));
      const autoPing = new AutoPingService(dataDir);
      const settings = { ...config(), dataDir };
      const bus = new EventBus();
      const get = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "working",
        workspaceExists: true,
      });
      const deliver = vi.fn().mockResolvedValue(undefined);
      const { startConfiguredTriggers } = await loadTriggersModule();
      const deps = {
        config: settings as never,
        bus,
        autoPing,
        sessionService: { get, deliver } as never,
        logger: { warn: vi.fn() },
      };
      let controller = startConfiguredTriggers(deps);
      try {
        readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
        bus.emit(githubEvent());
        await vi.advanceTimersByTimeAsync(1);
        await controller.stop();
        const record = readPendingSendBatchesMock().get("api:send:api-1") as PersistedPendingBatch;
        if (change === "event") settings.projects.api.triggers.send.event = "github:merge_conflict";
        else if (change === "source") settings.projects.api.sources["pr-watch"].type = "gitlab";
        else if (change === "destination") record.batch.sessionId = "api-2";
        else Object.assign(record.batch.autoPing?.items ?? {}, { "comment:1": null });
        get.mockResolvedValue({
          id: "api-1",
          status: "running",
          state: "waiting",
          lastActivityAt: staleActivity(),
          workspaceExists: true,
        });
        controller = startConfiguredTriggers(deps);
        await advanceSendWindow();
        expect(deliver).not.toHaveBeenCalled();
        expect(readPendingSendBatchesMock().size).toBe(0);
        expect(logSpurEventMock.mock.calls).toContainEqual([
          dataDir,
          expect.objectContaining({
            event: "trigger.send.restore_skipped",
            details: expect.objectContaining({
              reason: change === "malformed" ? "invalid_payload" : "route_changed",
            }),
          }),
        ]);
      } finally {
        await controller.stop();
        autoPing.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

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

  describe("memory-guard hold", () => {
    it("defaults to never held when the dep is omitted", async () => {
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
      } finally {
        await controller.stop();
      }
    });

    it("holds handleSendEvent's own immediate stale-parked delivery while the memory hold is engaged", async () => {
      // isStaleParked delivery bypasses the flush loop entirely (triggers.ts
      // :1133-1136), so handleSendEvent needs its own hold check distinct
      // from flushPending's — a "waiting"-state session's ordinary flush-loop
      // delivery never exercises this branch.
      const getMock = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "stopped",
        stopReason: "stale_timeout",
        state: "stale",
        lastActivityAt: recentActivity(),
        workspaceExists: true,
      });
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
      let held = true;
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: {
          get: getMock,
          deliver: deliverMock,
        } as never,
        memoryHoldEngaged: () => held,
        logger: { warn: vi.fn() },
      });

      try {
        bus.emit(githubEvent());
        await vi.advanceTimersByTimeAsync(0);
        expect(deliverMock).not.toHaveBeenCalled();

        held = false;
        for (let i = 0; i < 10 && deliverMock.mock.calls.length === 0; i += 1) {
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(deliverMock).toHaveBeenCalledTimes(1);
      } finally {
        await controller.stop();
      }
    });

    it("leaves the pending batch intact and logs trigger.send.suppressed_memory_guard when delivery is denied by the memory guard", async () => {
      const getMock = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
      const { startConfiguredTriggers } = await loadTriggersModule();
      // Import after loadTriggersModule()'s vi.resetModules() so this resolves to
      // the same session-service.js module instance triggers.ts uses internally
      // for the instanceof check.
      const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
      const deliverMock = vi
        .fn()
        .mockRejectedValue(new SessionAdmissionDeniedError("memory guard crossed", "memory_guard"));
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
          "trigger.send.suppressed_memory_guard",
        );
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
          "trigger.send.failed",
        );
      } finally {
        await controller.stop();
      }
    });

    it("never drops or retries a pending batch on the 3-attempt CI-failed schedule while the memory hold is engaged, and delivers it once the hold clears", async () => {
      const getMock = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "working",
        workspaceExists: true,
      });
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockImplementation(() => ciSnapshot());
      let held = true;
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config({ event: "github:ci_failed", interrupt: true }) as never,
        bus,
        sessionService: {
          get: getMock,
          deliver: deliverMock,
        } as never,
        memoryHoldEngaged: () => held,
        logger: { warn: vi.fn() },
      });

      try {
        bus.emit(ciFailedEvent());
        await vi.advanceTimersByTimeAsync(0);
        expect(deliverMock).not.toHaveBeenCalled();

        // Full 3-attempt CI-failed cadence (10 minutes apart) plus one extra
        // interval: never delivered, never dropped, while held.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(deliverMock).not.toHaveBeenCalled();
        expect(deletePendingSendBatchMock).not.toHaveBeenCalled();
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
          "trigger.send.dropped",
        );
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
          "trigger.send.failed",
        );

        held = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(deliverMock).toHaveBeenCalledTimes(1);
      } finally {
        await controller.stop();
      }
    });

    it("never drops or retries a pending batch on the 8-attempt delivery schedule while the memory hold is engaged, and delivers it once the hold clears", async () => {
      const getMock = vi.fn().mockResolvedValue({
        id: "api-1",
        status: "running",
        state: "waiting",
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockImplementation(() => commentSnapshot());
      let held = true;
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: {
          get: getMock,
          deliver: deliverMock,
        } as never,
        memoryHoldEngaged: () => held,
        logger: { warn: vi.fn() },
      });

      try {
        bus.emit(githubEvent());
        await advanceSendWindow();
        expect(deliverMock).not.toHaveBeenCalled();

        const backoffsMs = [10, 20, 40, 80, 160, 320, 640].map((seconds) => seconds * 1_000);
        for (const backoff of backoffsMs) {
          await vi.advanceTimersByTimeAsync(backoff);
        }
        expect(deliverMock).not.toHaveBeenCalled();
        expect(deletePendingSendBatchMock).not.toHaveBeenCalled();
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
          "trigger.send.dropped",
        );
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
          "trigger.send.failed",
        );

        held = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(deliverMock).toHaveBeenCalledTimes(1);
      } finally {
        await controller.stop();
      }
    });

    it("re-engages the hold once after a restart and keeps the reloaded batch queued", async () => {
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
          prUrl: "https://github.com/acme/api/pull/42",
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
      let held = true;
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: {
          get: getMock,
          deliver: deliverMock,
        } as never,
        memoryHoldEngaged: () => held,
        logger: { warn: vi.fn() },
      });

      try {
        // The reloaded batch is still on disk (never re-deleted) and no
        // delivery attempt is ever made while the restart-time hold is
        // engaged.
        await advanceSendWindow();
        expect(deliverMock).not.toHaveBeenCalled();
        expect(deletePendingSendBatchMock).not.toHaveBeenCalled();

        held = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(deliverMock).toHaveBeenCalledTimes(1);
      } finally {
        await controller.stop();
      }
    });

    it("keeps a batch for a memory_shed stop with no hold engaged, and drops it once the record is a manual_pause (memory hold engaged)", async () => {
      const stoppedSession = (stopReason: "memory_shed" | "manual_pause") => ({
        id: "api-1",
        status: "stopped",
        state: "stopped",
        stopReason,
        lastActivityAt: staleActivity(),
        workspaceExists: true,
      });
      const getMock = vi.fn().mockResolvedValue(stoppedSession("memory_shed"));
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
      let held = false;
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: {
          get: getMock,
          deliver: deliverMock,
        } as never,
        memoryHoldEngaged: () => held,
        logger: { warn: vi.fn() },
      });

      try {
        bus.emit(githubEvent());
        await advanceSendWindow();
        expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).not.toContain(
          "trigger.send.dropped",
        );
        expect(readPendingSendBatchesMock().size).toBe(1);

        getMock.mockResolvedValue(stoppedSession("manual_pause"));
        held = true;
        await vi.advanceTimersByTimeAsync(5_000);
        const dropped = logSpurEventMock.mock.calls.filter(
          ([, entry]) => entry.event === "trigger.send.dropped",
        );
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.[1].details?.reason).toBe("closed_session");
        expect(readPendingSendBatchesMock().size).toBe(0);
        expect(deliverMock).not.toHaveBeenCalled();
      } finally {
        await controller.stop();
      }
    });
  });

  describe("interactive (telegram) send window", () => {
    function telegramConfig() {
      return {
        dataDir: DATA_DIR,
        projects: {
          api: {
            sources: { tg: { type: "telegram" } },
            triggers: {
              chat: { source: "tg", event: "telegram:message", send: { interrupt: false } },
            },
          },
        },
      };
    }

    function telegramEvent(messageId: number, text: string) {
      return {
        name: "telegram:message",
        occurrenceId: `tg-${messageId}`,
        projectId: "api",
        sourceId: "tg",
        data: { sessionId: "api-1", chatId: 123, userId: 7, messageId, text },
      };
    }

    function waitingSession(lastActivityAt: string, state = "waiting") {
      return {
        id: "api-1",
        status: "running",
        state,
        lastActivityAt,
        workspaceExists: true,
      };
    }

    async function startTelegram(getMock: ReturnType<typeof vi.fn>) {
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: telegramConfig() as never,
        bus,
        sessionService: { get: getMock, deliver: deliverMock } as never,
        logger: { warn: vi.fn() },
      });
      return { bus, controller, deliverMock };
    }

    it("delivers a telegram message to a waiting agent 2s after it arrives", async () => {
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const { bus, controller, deliverMock } = await startTelegram(getMock);
      try {
        bus.emit(telegramEvent(1, "hello there"));
        await vi.advanceTimersByTimeAsync(1_999);
        expect(deliverMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(101);
        expect(deliverMock).toHaveBeenCalledTimes(1);
        expect(deliverMock).toHaveBeenCalledWith("api-1", expect.stringContaining("hello there"), {
          interrupt: false,
        });
      } finally {
        await controller.stop();
      }
    });

    it("merges telegram messages inside the 2s window into one delivery", async () => {
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const { bus, controller, deliverMock } = await startTelegram(getMock);
      try {
        bus.emit(telegramEvent(1, "first part"));
        await vi.advanceTimersByTimeAsync(500);
        const timersAfterFirst = vi.getTimerCount();
        bus.emit(telegramEvent(2, "second part"));
        await vi.advanceTimersByTimeAsync(0);
        // A merge adds no flush timer.
        expect(vi.getTimerCount()).toBe(timersAfterFirst);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(deliverMock).toHaveBeenCalledTimes(1);
        const text = deliverMock.mock.calls[0]?.[1] as string;
        expect(text).toContain("first part");
        expect(text).toContain("second part");
      } finally {
        await controller.stop();
      }
    });

    it("holds a telegram message until 2s after the agent's last activity", async () => {
      const getMock = vi
        .fn()
        .mockResolvedValue(waitingSession(new Date(Date.now() + 1_500).toISOString()));
      const { bus, controller, deliverMock } = await startTelegram(getMock);
      try {
        bus.emit(telegramEvent(1, "hello there"));
        await vi.advanceTimersByTimeAsync(2_100);
        expect(deliverMock).not.toHaveBeenCalled();
        // The timer waits for the activity gate (3.5s), not the 5s tick.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(deliverMock).toHaveBeenCalledTimes(1);
      } finally {
        await controller.stop();
      }
    });

    it("delivers a telegram batch once when the timer and the flush tick both fire", async () => {
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const { bus, controller, deliverMock } = await startTelegram(getMock);
      try {
        bus.emit(telegramEvent(1, "hello there"));
        await vi.advanceTimersByTimeAsync(12_000);
        expect(deliverMock).toHaveBeenCalledTimes(1);
      } finally {
        await controller.stop();
      }
    });

    it("restored telegram batch uses the 2s window", async () => {
      const persisted: PersistedPendingBatch = {
        queueKey: "api:chat:api-1",
        projectId: "api",
        triggerId: "chat",
        sourceId: "tg",
        batch: {
          kind: "telegram",
          sessionId: "api-1",
          messages: [
            { sessionId: "api-1", chatId: 123, userId: 7, messageId: 1, text: "restored hello" },
          ],
        },
      };
      readPendingSendBatchesMock.mockReturnValue(new Map([[persisted.queueKey, persisted]]));
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const { controller, deliverMock } = await startTelegram(getMock);
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(deliverMock).toHaveBeenCalledWith(
          "api-1",
          expect.stringContaining("restored hello"),
          { interrupt: false },
        );
      } finally {
        await controller.stop();
      }
    });

    it("stop clears a pending telegram flush timer", async () => {
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const { bus, controller, deliverMock } = await startTelegram(getMock);
      bus.emit(telegramEvent(1, "hello there"));
      await vi.advanceTimersByTimeAsync(0);
      await controller.stop();
      getMock.mockClear();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(deliverMock).not.toHaveBeenCalled();
      expect(getMock).not.toHaveBeenCalled();
    });

    it("merges events that arrive while the agent works into one follow-up delivery", async () => {
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const { bus, controller, deliverMock } = await startTelegram(getMock);
      try {
        bus.emit(telegramEvent(1, "text 1"));
        await vi.advanceTimersByTimeAsync(2_100);
        expect(deliverMock).toHaveBeenCalledTimes(1);

        getMock.mockResolvedValue(waitingSession(new Date().toISOString(), "working"));
        await vi.advanceTimersByTimeAsync(900);
        bus.emit(telegramEvent(2, "text 2"));
        await vi.advanceTimersByTimeAsync(1_000);
        bus.emit(telegramEvent(3, "text 3"));
        await vi.advanceTimersByTimeAsync(1_000);
        bus.emit(telegramEvent(4, "text 4"));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(deliverMock).toHaveBeenCalledTimes(1);

        getMock.mockResolvedValue(waitingSession(new Date().toISOString()));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(deliverMock).toHaveBeenCalledTimes(2);
        const second = deliverMock.mock.calls[1]?.[1] as string;
        expect(second).toContain("text 2");
        expect(second).toContain("text 3");
        expect(second).toContain("text 4");
      } finally {
        await controller.stop();
      }
    });

    it("keeps the 30s window for non-telegram batches", async () => {
      const getMock = vi.fn().mockResolvedValue(waitingSession(staleActivity()));
      const deliverMock = vi.fn().mockResolvedValue(undefined);
      readGitHubSourceSnapshotMock.mockReturnValue(commentSnapshot());
      const { startConfiguredTriggers } = await loadTriggersModule();
      const bus = new EventBus();
      const controller = startConfiguredTriggers({
        config: config() as never,
        bus,
        sessionService: { get: getMock, deliver: deliverMock } as never,
        logger: { warn: vi.fn() },
      });
      try {
        bus.emit(githubEvent());
        await vi.advanceTimersByTimeAsync(10_000);
        expect(deliverMock).not.toHaveBeenCalled();
      } finally {
        await controller.stop();
      }
    });
  });
});

describe("dropsQueuedSend", () => {
  it("closes stopped, error, killed except a live server-error wedge and a memory_shed stop", async () => {
    const { dropsQueuedSend } = await loadTriggersModule();

    expect(dropsQueuedSend({ state: "stopped", status: "stopped" })).toBe(true);
    expect(dropsQueuedSend({ state: "stopped", status: "running" })).toBe(false);
    expect(dropsQueuedSend({ state: "killed", status: "killed" })).toBe(true);
    expect(dropsQueuedSend({ state: "error", status: "errored" })).toBe(true);
    expect(dropsQueuedSend({ state: "error", status: "running" })).toBe(false);
    expect(
      dropsQueuedSend({ state: "stopped", status: "stopped", stopReason: "memory_shed" }),
    ).toBe(false);
    expect(
      dropsQueuedSend({ state: "stopped", status: "stopped", stopReason: "manual_pause" }),
    ).toBe(true);
    expect(dropsQueuedSend({ state: "killed", status: "killed", stopReason: "memory_shed" })).toBe(
      true,
    );
    expect(
      dropsQueuedSend({ state: "stale", status: "stopped", stopReason: "stale_timeout" }),
    ).toBe(false);
    expect(dropsQueuedSend({ state: "waiting", status: "running" })).toBe(false);
  });
});
