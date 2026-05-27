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

function trackSeenComments(initial: readonly string[] = []): Set<string> {
  const seen = new Set<string>(initial);
  readCommentSeenRegistryMock.mockImplementation(() => new Set(seen));
  recordCommentSeenMock.mockImplementation(
    (_dataDir: string, _projectId: string, _sourceId: string, ids: readonly string[]) => {
      for (const id of ids) seen.add(id);
    },
  );
  return seen;
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
    const seenIds = trackSeenComments();
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
    trackSeenComments(["9001"]);
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
    trackSeenComments(["9001"]);
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

  it("emits github:work_item.new for unseen query results when the repo already has seen entries", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/api#1"]));
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
        query: "repo:acme/api",
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

  it("queries open PRs with a state flag and no is: qualifiers", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    ghMock.mockResolvedValueOnce("[]");

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        query: "repo:acme/api",
      },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const searchCall = ghMock.mock.calls.find((call) => call[1] === "search" && call[2] === "prs");
    expect(searchCall).toBeDefined();
    const argv = (searchCall ?? []).map(String);
    const stateIndex = argv.indexOf("--state");
    expect(stateIndex).toBeGreaterThan(-1);
    expect(argv[stateIndex + 1]).toBe("open");
    expect(argv.some((arg) => arg.includes("is:"))).toBe(false);

    handle.stop();
  });

  it("suppresses emits on the first poll for a repo with no seen entries", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    readWorkItemRegistryMock.mockReturnValue(new Set(["legacy/old#3"]));
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 7,
          title: "Backlog A",
          url: "https://github.com/acme/api/pull/7",
          repository: { nameWithOwner: "acme/api" },
        },
        {
          number: 8,
          title: "Backlog B",
          url: "https://github.com/acme/api/pull/8",
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
        query: "repo:acme/api",
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
    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "pr-watch",
      "acme/api#8",
    );
    expect(emit).not.toHaveBeenCalledWith("github:work_item.new", expect.anything());

    handle.stop();
  });

  it("emits only for genuinely new PRs once the repo has seen entries", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/api#7"]));
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 7,
          title: "Already seen",
          url: "https://github.com/acme/api/pull/7",
          repository: { nameWithOwner: "acme/api" },
        },
        {
          number: 8,
          title: "Brand new",
          url: "https://github.com/acme/api/pull/8",
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
        query: "repo:acme/api",
      },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "pr-watch",
      "acme/api#8",
    );
    expect(recordWorkItemMock).not.toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "pr-watch",
      "acme/api#7",
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("github:work_item.new", {
      externalId: "acme/api#8",
      url: "https://github.com/acme/api/pull/8",
      number: 8,
      title: "Brand new",
      repo: "acme/api",
    });

    handle.stop();
  });
});
