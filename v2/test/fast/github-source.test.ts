import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/types.js";

const ghMock = vi.fn();
const listSessionsMock = vi.fn();
const readReviewSourceSnapshotsMock = vi.fn();
const writeReviewSourceSnapshotMock = vi.fn();
const deleteReviewSourceSnapshotMock = vi.fn();
const hasGitHubMergeConflictRestoreReplayMock = vi.fn();
const clearGitHubMergeConflictRestoreReplayMock = vi.fn();
const readWorkItemRegistryMock = vi.fn();
const recordWorkItemMock = vi.fn();
const readCommentSeenRegistryMock = vi.fn();
const recordCommentSeenMock = vi.fn();

vi.mock("../../src/gh.js", () => ({
  gh: ghMock,
}));
vi.mock("../../src/metadata.js", () => ({
  clearGitHubMergeConflictRestoreReplay: clearGitHubMergeConflictRestoreReplayMock,
  deleteReviewSourceSnapshot: deleteReviewSourceSnapshotMock,
  hasGitHubMergeConflictRestoreReplay: hasGitHubMergeConflictRestoreReplayMock,
  listSessions: listSessionsMock,
  readCommentSeenRegistry: readCommentSeenRegistryMock,
  readReviewSourceSnapshots: readReviewSourceSnapshotsMock,
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordCommentSeen: recordCommentSeenMock,
  recordWorkItem: recordWorkItemMock,
  writeReviewSourceSnapshot: writeReviewSourceSnapshotMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

const { githubSourceModule } = await import("../../src/event-sources/github.js");

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    agent: "claude",
    prompt: "fix the bug",
    branch: "feature/native-pr-binding",
    pr: {
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    },
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api-a1b2",
    tmuxSession: "api-a1b2",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-04-26T09:00:00.000Z",
    updatedAt: "2026-04-26T09:00:00.000Z",
    ...overrides,
  };
}

describe("github source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasGitHubMergeConflictRestoreReplayMock.mockReturnValue(false);
    readWorkItemRegistryMock.mockReturnValue(new Set());
    readCommentSeenRegistryMock.mockReturnValue(new Set());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing snapshot when gh pr view fails transiently", async () => {
    const existingSnapshot = new Map([
      [
        "ci_failed",
        {
          key: "ci_failed",
          kind: "ci_failed" as const,
          text: "CI is failing: runtime suite.",
        },
      ],
    ]);
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", existingSnapshot]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock.mockRejectedValueOnce(new Error("gh offline"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
    });

    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to poll api-a1b2: gh offline"),
    );

    handle.stop();
  });

  it("does not emit ci_failed when the GitHub rollup is successful with skipped rows", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock
      .mockResolvedValueOnce(
        JSON.stringify({
          number: 42,
          title: "Fix CI alert",
          url: "https://github.com/acme/api/pull/42",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            { name: "workflow", conclusion: "SUCCESS" },
            { name: "skipped job", conclusion: "SKIPPED" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          { name: "old failed row", state: "FAILURE" },
          { name: "skipped job", state: "SKIPPED" },
          { name: "neutral job", state: "NEUTRAL" },
        ]),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(emit).not.toHaveBeenCalledWith("github:ci_failed", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as unknown;
    expect(snapshot).toBeInstanceOf(Map);
    if (snapshot instanceof Map) {
      expect(snapshot.has("ci_failed")).toBe(false);
    }

    handle.stop();
  });

  it("records and suppresses already-seen issue comment ids", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession()]);
    const seenIds = new Set<string>();
    readCommentSeenRegistryMock.mockImplementation(() => new Set(seenIds));
    recordCommentSeenMock.mockImplementation(
      (_dataDir: string, _projectId: string, _sourceId: string, ids: readonly string[]) => {
        for (const id of ids) seenIds.add(id);
      },
    );
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        number: 42,
        title: "Fix CI alert",
        url: "https://github.com/acme/api/pull/42",
        reviewDecision: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ name: "workflow", conclusion: "SUCCESS" }],
      }),
    );
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce(
      JSON.stringify([{ id: 9001, body: "first pass please", user: { login: "alice" } }]),
    );

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(recordCommentSeenMock).toHaveBeenCalledWith("/tmp/spur-data", "api", "pr-watch", [
      "9001",
    ]);
    expect(seenIds.has("9001")).toBe(true);
    handle.stop();
  });

  it("does not re-emit issue comments observed on a previous poll", async () => {
    const seenIds = new Set<string>(["9001"]);
    readCommentSeenRegistryMock.mockImplementation(() => new Set(seenIds));
    recordCommentSeenMock.mockImplementation(
      (_dataDir: string, _projectId: string, _sourceId: string, ids: readonly string[]) => {
        for (const id of ids) seenIds.add(id);
      },
    );
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          new Map([
            [
              "comment:9001",
              {
                key: "comment:9001",
                kind: "comment" as const,
                text: 'New PR comment from alice: "first pass please"',
              },
            ],
          ]),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        number: 42,
        title: "Fix CI alert",
        url: "https://github.com/acme/api/pull/42",
        reviewDecision: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ name: "workflow", conclusion: "SUCCESS" }],
      }),
    );
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce(
      JSON.stringify([{ id: 9001, body: "first pass please", user: { login: "alice" } }]),
    );

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    handle.stop();
  });

  it("emits only the newly observed issue comment when one of two is already seen", async () => {
    const seenIds = new Set<string>(["9001"]);
    readCommentSeenRegistryMock.mockImplementation(() => new Set(seenIds));
    recordCommentSeenMock.mockImplementation(
      (_dataDir: string, _projectId: string, _sourceId: string, ids: readonly string[]) => {
        for (const id of ids) seenIds.add(id);
      },
    );
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          new Map([
            [
              "comment:9001",
              {
                key: "comment:9001",
                kind: "comment" as const,
                text: 'New PR comment from alice: "first pass please"',
              },
            ],
          ]),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        number: 42,
        title: "Fix CI alert",
        url: "https://github.com/acme/api/pull/42",
        reviewDecision: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ name: "workflow", conclusion: "SUCCESS" }],
      }),
    );
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: 9001, body: "first pass please", user: { login: "alice" } },
        { id: 9002, body: "second look", user: { login: "bob" } },
      ]),
    );

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(recordCommentSeenMock).toHaveBeenCalledWith("/tmp/spur-data", "api", "pr-watch", [
      "9002",
    ]);
    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "comment:9002" })],
      }),
    );
    handle.stop();
  });

  it("emits github:work_item.new for unseen query results", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 7,
          title: "Work item",
          url: "https://github.com/acme/api/pull/7",
          repository: { nameWithOwner: "acme/api" },
        },
      ]),
    );
    const emit = vi.fn();

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        query: "is:pr is:open label:spur",
      },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "pr-watch",
      "acme/api#7",
    );
    expect(emit).toHaveBeenCalledWith("github:work_item.new", {
      externalId: "acme/api#7",
      url: "https://github.com/acme/api/pull/7",
      number: 7,
      title: "Work item",
      repo: "acme/api",
    });

    handle.stop();
  });
});
