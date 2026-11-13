// First import: registers the harness's vi.mock()s before any src module loads.
import {
  TEST_DATA_DIR,
  baseConfig,
  createSessionStore,
  createTmuxSessionMock,
  disposeSessionServiceHarness,
  isProcessRunningInTmuxMock,
  loadConfigMock,
  loadSessionServiceModule,
  logSpurEventMock,
  mockClaudeJsonlState,
  mockClaudeSessionStatus,
  readClaudeJsonlStateMock,
  readTelegramBindingsMock,
  readTelegramReplyTargetMock,
  reserveNextSessionIdMock,
  resetSessionServiceHarness,
  sendTelegramReplyMock,
  tmuxSessionExistsMock,
  workspaceExistsMock,
} from "../helpers/session-service-harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as githubProviderModule from "../../src/review-providers/github.js";
import type * as metadataModule from "../../src/metadata.js";

// The delivery path refreshes queued feedback through the GitHub provider; no
// network in this test, every queued signal is still live.
vi.mock("../../src/review-providers/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof githubProviderModule>();
  return {
    ...actual,
    githubReviewProvider: {
      ...actual.githubReviewProvider,
      refreshSignals: async (input: { signals: { key: string }[] }) =>
        input.signals.map((signal) => ({ status: "live", key: signal.key, signal })),
    },
  };
});

const worktreePath = "/tmp/spur-worktrees/api/api-1";
const SEND_WINDOW_MS = 35_000;

function projectConfig() {
  const config = baseConfig();
  config.projects.api.sources = {
    "pr-watch": { type: "github" },
    agentChat: {
      type: "telegram",
      runOnStart: false,
      token: "token-123",
      allowedUsers: [123],
      chatId: -1001,
    },
  } as never;
  config.projects.api.triggers = {
    "gh-ci-failed": {
      source: "pr-watch",
      event: "github:ci_failed",
      send: { interrupt: false },
    },
  } as never;
  return config;
}

function seedIncident() {
  const sessions = createSessionStore();
  sessions.set("api-1", {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "own the PR",
    branch: "api-1",
    worktree: true,
    worktreePath,
    tmuxSession: "api-1",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "stopped",
    stopReason: "manual_pause",
    closeoutOwner: true,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  });
  sessions.set("api-2", {
    id: "api-2",
    project: "api",
    workspaceId: "api-1",
    agent: "claude",
    prompt: "helper",
    branch: "api-1",
    worktree: true,
    worktreePath,
    tmuxSession: "api-2",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "running",
    closeoutOwner: false,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  });
  return sessions;
}

function ciFailedEvent(sessionId: string, alert: number) {
  return {
    name: "github:ci_failed",
    occurrenceId: `ci-failed-${sessionId}-${alert}`,
    projectId: "api",
    sourceId: "pr-watch",
    data: {
      sessionId,
      repo: "acme/api",
      prUrl: "https://github.com/acme/api/pull/42",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [
        { key: "ci_failed", kind: "ci_failed" as const, text: "CI is failing: test suite." },
      ],
    },
  };
}

describe("closeout incident replay", () => {
  beforeEach(() => resetSessionServiceHarness(() => []));
  afterEach(disposeSessionServiceHarness);

  it.each([[["gh-ci-failed"]], [[]]] as const)(
    "reuse spawn takes closeout and allowedTriggers %j shapes the owner's CI alerts",
    async (allowedTriggers) => {
      const sessions = seedIncident();
      loadConfigMock.mockReturnValue(projectConfig());
      workspaceExistsMock.mockReturnValue(true);
      mockClaudeJsonlState("waiting");
      tmuxSessionExistsMock.mockImplementation(async (name: string) => name !== "api-1");
      isProcessRunningInTmuxMock.mockImplementation(async (name: string) => name !== "api-1");
      reserveNextSessionIdMock.mockResolvedValue("api-3");
      const topic = {
        sessionId: "api-3",
        projectId: "api",
        sourceId: "agentChat",
        chatId: -1001,
        messageThreadId: 22,
        updatedAt: "2026-03-18T10:02:00.000Z",
      };
      readTelegramReplyTargetMock.mockImplementation((_dir: string, sessionId: string) =>
        sessionId === "api-3" ? topic : null,
      );
      readTelegramBindingsMock.mockReturnValue(
        new Map([["-1001:22", { chatId: -1001, messageThreadId: 22, sessionId: "api-3" }]]),
      );
      const { SessionService } = await loadSessionServiceModule();
      const { startConfiguredTriggers } = await import("../../src/triggers.js");
      const { AutoPingService } = await import("../../src/auto-ping.js");
      const actualMetadata = await vi.importActual<typeof metadataModule>("../../src/metadata.js");
      const policyDir = mkdtempSync(join(tmpdir(), "spur-replay-policy-"));
      const autoPing = new AutoPingService(policyDir);
      const { EventBus } = await import("../../src/event-bus.js");
      const bus = new EventBus();
      let service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const delivered: string[] = [];

      const startController = () => {
        const realGet = service.get.bind(service);
        vi.spyOn(service, "get").mockImplementation(async (id: string) => ({
          ...(await realGet(id)),
          state: "waiting" as const,
          lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        }));
        vi.spyOn(service, "deliver").mockImplementation(async (id: string) => {
          delivered.push(id);
          return undefined as never;
        });
        const current = service;
        return startConfiguredTriggers({
          config: current.config,
          bus,
          sessionService: current,
          autoPing,
          noticeBlockedTrigger: (id, triggerId) => current.noticeBlockedTrigger(id, triggerId),
          logger: { warn: vi.fn() },
        });
      };
      const alert = async (alertNumber: number) => {
        bus.emit(ciFailedEvent("api-3", alertNumber));
        bus.emit(ciFailedEvent("api-2", alertNumber));
        await vi.advanceTimersByTimeAsync(SEND_WINDOW_MS);
      };
      const count = (id: string) => delivered.filter((entry) => entry === id).length;
      const events = (event: string, sessionId: string) =>
        logSpurEventMock.mock.calls
          .map(([, entry]) => entry)
          .filter((entry) => entry.event === event && entry.sessionId === sessionId);

      try {
        await service.spawn({
          project: "api",
          prompt: "continue the task",
          reuseWorkspaceSessionId: "api-1",
          allowedTriggers: [...allowedTriggers],
        });

        expect(sessions.get("api-3")?.closeoutOwner).toBe(true);
        expect(sessions.get("api-1")?.closeoutOwner).toBe(false);
        expect(createTmuxSessionMock.mock.calls.at(-1)?.[0]?.env?.SPUR_CLOSEOUT_OWNER).toBe("1");
        expect(
          logSpurEventMock.mock.calls.filter(
            ([, entry]) => entry.event === "session.closeout.taken",
          ),
        ).toHaveLength(1);

        for (const id of ["api-2", "api-3"]) {
          actualMetadata.writeGitHubSourceSnapshot(TEST_DATA_DIR, "api", "pr-watch", id, {
            prNumber: 42,
            signals: new Map([
              [
                "ci_failed",
                { key: "ci_failed", kind: "ci_failed", text: "CI is failing: test suite." },
              ],
            ]),
          });
        }

        let controller = startController();
        await alert(1);
        await alert(2);
        await alert(3);

        expect(count("api-2")).toBe(3);
        if (allowedTriggers.length > 0) {
          expect(count("api-3")).toBe(3);
          expect(events("trigger.send.blocked_notice", "api-3")).toHaveLength(0);
          expect(sendTelegramReplyMock).not.toHaveBeenCalled();
          return;
        }

        expect(count("api-3")).toBe(0);
        expect(
          events("trigger.send.dropped", "api-3").filter(
            (entry) => entry.details?.reason === "trigger_not_allowed",
          ),
        ).toHaveLength(3);
        expect(events("trigger.send.blocked_notice", "api-3")).toHaveLength(1);
        await vi.waitFor(() => expect(sendTelegramReplyMock).toHaveBeenCalledTimes(1));

        await controller.stop();
        service.dispose();
        service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
        controller = startController();
        await alert(4);

        expect(count("api-3")).toBe(0);
        expect(count("api-2")).toBe(4);
        expect(events("trigger.send.blocked_notice", "api-3")).toHaveLength(1);
        expect(sendTelegramReplyMock).toHaveBeenCalledTimes(1);
        await controller.stop();
      } finally {
        service.dispose();
        autoPing.dispose();
        rmSync(policyDir, { recursive: true, force: true });
      }
    },
  );

  it("drops a held CI send after clear and nudges one blocked closeout notice", async () => {
    const sessions = seedIncident();
    const owner = sessions.get("api-1");
    if (!owner) throw new Error("Missing closeout owner fixture");
    sessions.set("api-1", {
      ...owner,
      status: "running",
      stopReason: undefined,
      allowedTriggers: [],
      rateLimitedAt: "2026-03-18T10:00:00.000Z",
    });
    loadConfigMock.mockReturnValue(projectConfig());
    mockClaudeSessionStatus("waiting", "idle");
    const filePath = "test.jsonl";
    const key = JSON.stringify([filePath, "held-limit"]);
    readClaudeJsonlStateMock.mockResolvedValue({
      state: "waiting",
      reader: {
        filePath,
        lastOffset: 1,
        lastMtimeMs: 1,
        tailRecords: [],
        rateLimitCounts: { [key]: 1 },
      },
      rateLimit: {
        limited: true,
        reason: "claude rate_limit",
        source: { filePath, key, ordinal: 1 },
      },
      serverError: false,
    });
    const { SessionService } = await loadSessionServiceModule();
    const { startConfiguredTriggers } = await import("../../src/triggers.js");
    const { AutoPingService } = await import("../../src/auto-ping.js");
    const { EventBus } = await import("../../src/event-bus.js");
    const actualMetadata = await vi.importActual<typeof metadataModule>("../../src/metadata.js");
    const policyDir = mkdtempSync(join(tmpdir(), "spur-held-closeout-"));
    const autoPing = new AutoPingService(policyDir);
    const bus = new EventBus();
    let service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    const deliver = vi.fn().mockResolvedValue(undefined);
    const startController = () => {
      vi.spyOn(service, "deliver").mockImplementation(deliver);
      const current = service;
      return startConfiguredTriggers({
        config: current.config,
        bus,
        sessionService: current,
        autoPing,
        noticeBlockedTrigger: (id, triggerId) => current.noticeBlockedTrigger(id, triggerId),
        logger: { warn: vi.fn() },
      });
    };
    actualMetadata.writeGitHubSourceSnapshot(TEST_DATA_DIR, "api", "pr-watch", "api-1", {
      prNumber: 42,
      signals: new Map([
        ["ci_failed", { key: "ci_failed", kind: "ci_failed", text: "CI is failing: test suite." }],
      ]),
    });
    let controller = startController();
    const events = (event: string) =>
      logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event === event && entry.sessionId === "api-1");
    try {
      bus.emit(ciFailedEvent("api-1", 1));
      await vi.advanceTimersByTimeAsync(SEND_WINDOW_MS);
      expect(actualMetadata.readPendingSendBatches(TEST_DATA_DIR).size).toBe(1);
      expect(deliver).not.toHaveBeenCalled();
      expect(events("trigger.send.dropped")).toHaveLength(0);

      const cleared = await service.clearRateLimit("api-1", true, "cli");
      expect(cleared).toMatchObject({ state: "waiting", deliveryScheduled: true });
      if (cleared.deliveryScheduled) controller.nudgeSession("api-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(actualMetadata.readPendingSendBatches(TEST_DATA_DIR).size).toBe(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(
        events("trigger.send.dropped").filter(
          (entry) => entry.details?.reason === "trigger_not_allowed",
        ),
      ).toHaveLength(1);
      expect(events("trigger.send.blocked_notice")).toHaveLength(1);
      expect(sessions.get("api-1")?.blockedTriggerNotices).toEqual(["gh-ci-failed"]);

      await controller.stop();
      service.dispose();
      service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      controller = startController();
      bus.emit(ciFailedEvent("api-1", 2));
      await vi.advanceTimersByTimeAsync(SEND_WINDOW_MS);
      expect(deliver).not.toHaveBeenCalled();
      expect(events("trigger.send.blocked_notice")).toHaveLength(1);
    } finally {
      await controller.stop();
      service.dispose();
      autoPing.dispose();
      rmSync(policyDir, { recursive: true, force: true });
    }
  });
});
