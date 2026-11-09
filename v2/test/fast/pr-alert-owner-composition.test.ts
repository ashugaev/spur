import {
  baseConfig,
  createSessionStore,
  disposeSessionServiceHarness,
  ghMock,
  loadConfigMock,
  loadSessionServiceModule,
  readSessionMock,
  resetSessionServiceHarness,
  reserveNextSessionIdMock,
  workspaceExistsMock,
} from "../helpers/session-service-harness.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as metadataModule from "../../src/metadata.js";
import type * as workspaceModule from "../../src/workspace.js";
import type { ReviewEventData, SessionRecord } from "../../src/types.js";

beforeEach(() => resetSessionServiceHarness(() => []));
afterEach(() => disposeSessionServiceHarness());

it("rechecks both native PR alerts after denied stale-owner handoff rolls back before the next source poll", async () => {
  const config = baseConfig();
  config.projects.api.sources = { checks: { type: "github" } };
  config.projects.api.triggers = {
    ci: { source: "checks", event: "github:ci_failed", send: { interrupt: false } },
    conflict: { source: "checks", event: "github:merge_conflict", send: { interrupt: false } },
  };
  loadConfigMock.mockReturnValue(config);
  const pr = { number: 42, repo: "acme/api", url: "https://github.com/acme/api/pull/42" };
  const owner: SessionRecord = {
    id: "api-1",
    project: "api",
    workspaceId: "api-1",
    agent: "claude",
    prompt: "owner",
    branch: "feature/test",
    worktree: false,
    worktreePath: config.dataDir,
    tmuxSession: "api-1",
    launchCommand: "claude",
    status: "stopped",
    stopReason: "stale_timeout",
    pr,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
  };
  const sessions = createSessionStore(owner);
  const { SessionService } = await loadSessionServiceModule();
  const service = new SessionService("/tmp/spur.yaml", owner.createdAt, {
    deferBackgroundLoops: true,
  });
  let failLaunch = () => {};
  const heldLaunch = new Promise<void>((resolve) => {
    failLaunch = resolve;
  });
  const internals = service as unknown as {
    persistSpawnPlaceholder(
      record: SessionRecord,
      requested: boolean,
      written: () => void,
    ): Promise<void>;
  };
  const persist = internals.persistSpawnPlaceholder.bind(internals);
  vi.spyOn(internals, "persistSpawnPlaceholder").mockImplementation(async (...args) => {
    await persist(...args);
    await heldLaunch;
    throw new Error("proved prelaunch failure");
  });
  const { writeWorkspaceState, readPrAlertOwnership } =
    await import("../../src/workspace-store.js");
  writeWorkspaceState(config.dataDir, owner.id, {
    pr,
    prAlertOwner: { state: "owned", sessionId: owner.id },
  });

  // Keep native lifecycle mocks; let the source use real durable snapshot storage.
  vi.doMock("../../src/metadata.js", async (importOriginal) => ({
    ...(await importOriginal<typeof metadataModule>()),
    readSession: readSessionMock,
    listSessions: () => [sessions.get(owner.id)!],
  }));
  vi.doMock("../../src/workspace.js", async (importOriginal) => ({
    ...(await importOriginal<typeof workspaceModule>()),
    isGitWorktree: async () => true,
    readBranchPushUrl: async () => "git@github.com:acme/api.git",
    readRemoteUrls: async () => new Map([["origin", "git@github.com:acme/api.git"]]),
  }));
  vi.resetModules();
  const { githubSourceModule } = await import("../../src/event-sources/github.js");
  const { createSendBatchParser } = await import("../../src/send-batches.js");
  const { allowsPrAlertBatch } = await import("../../src/pr-alert-owner.js");
  const poll = async () => {
    ghMock.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "api" && args.includes("graphql"))
        return JSON.stringify({
          data: {
            viewer: { login: "bot" },
            rateLimit: { cost: 1, remaining: 4800, resetAt: "2026-03-18T11:00:00.000Z" },
            r: {
              a0: {
                number: 42,
                title: "Fix",
                url: pr.url,
                state: "OPEN",
                isDraft: false,
                headRefName: owner.branch,
                baseRefName: "main",
                headRefOid: "same-head",
                headRepository: { nameWithOwner: "acme/api" },
                mergeable: "CONFLICTING",
                reviewDecision: null,
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [{ name: "test", conclusion: "FAILURE", status: "COMPLETED" }],
                          },
                        },
                      },
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                reviews: { nodes: [] },
                latestOpinionatedReviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
              },
            },
          },
        });
      return "[]";
    });
    const emitted: { name: string; data: ReviewEventData }[] = [];
    const warn = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "checks",
      projectId: "api",
      dataDir: config.dataDir,
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit: (name, data) => {
        emitted.push({ name, data: data as ReviewEventData });
      },
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn },
      resolveWebBaseUrl: async () => "http://localhost",
    });
    handle.stop();
    expect(warn.mock.calls).toEqual([]);
    return emitted.filter(
      ({ name }) => name === "github:ci_failed" || name === "github:merge_conflict",
    );
  };
  try {
    const initial = await poll();
    expect(initial.map(({ name }) => name).sort()).toEqual([
      "github:ci_failed",
      "github:merge_conflict",
    ]);
    const parse = createSendBatchParser("github", "api", "checks");
    const batches = initial.map(({ data }) => parse(data));
    expect(batches.every(Boolean)).toBe(true);
    reserveNextSessionIdMock.mockResolvedValue("api-2");
    workspaceExistsMock.mockReturnValue(true);
    let handoffError: unknown;
    const handoff = service
      .handoff(owner.id, { agent: "claude" }, { todoActor: { kind: "human" } })
      .catch((error: unknown) => {
        handoffError = error;
      });
    await vi.waitFor(() => {
      if (handoffError) throw handoffError;
      expect(sessions.get("api-2")?.prAlertTransfer).toBeDefined();
    });
    expect(sessions.get(owner.id)?.stopReason).toBe("stale_timeout");
    for (const batch of batches) {
      expect(allowsPrAlertBatch(config.dataDir, owner, batch!.serialize())).toBe(false);
      let accepted = false;
      await service.deliver(owner.id, batch!.format(), {
        allowDelivery: () => allowsPrAlertBatch(config.dataDir, owner, batch!.serialize()),
        observeDelivery: (stage) => {
          if (stage === "accepted") accepted = true;
        },
      });
      expect(accepted).toBe(false);
    }
    failLaunch();
    await handoff;
    expect(handoffError).toMatchObject({
      message: expect.stringContaining("proved prelaunch failure"),
    });
    expect(readPrAlertOwnership(config.dataDir, owner.id)).toEqual({
      state: "owned",
      sessionId: owner.id,
      ownerRollbackId: "api-2",
    });
    const returned = await poll();
    expect(returned.map(({ name }) => name).sort()).toEqual([
      "github:ci_failed",
      "github:merge_conflict",
    ]);
    expect(returned.map(({ data }) => data.signals)).toEqual(
      initial.map(({ data }) => data.signals),
    );
    expect(await poll()).toEqual([]);
  } finally {
    failLaunch();
    service.dispose();
    await service.settleBackgroundSpawns();
  }
});
