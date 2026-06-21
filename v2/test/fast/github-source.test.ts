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
const readLifecycleBaselinedSessionsMock = vi.fn();
const recordLifecycleBaselinedSessionMock = vi.fn();
const removeLifecycleBaselinedSessionMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/gh.js", () => ({
  gh: ghMock,
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));
vi.mock("../../src/metadata.js", () => ({
  clearGitHubMergeConflictRestoreReplay: clearGitHubMergeConflictRestoreReplayMock,
  deleteReviewSourceSnapshot: deleteReviewSourceSnapshotMock,
  hasGitHubMergeConflictRestoreReplay: hasGitHubMergeConflictRestoreReplayMock,
  listSessions: listSessionsMock,
  readCommentSeenRegistry: readCommentSeenRegistryMock,
  readLifecycleBaselinedSessions: readLifecycleBaselinedSessionsMock,
  readReviewSourceSnapshots: readReviewSourceSnapshotsMock,
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordCommentSeen: recordCommentSeenMock,
  recordLifecycleBaselinedSession: recordLifecycleBaselinedSessionMock,
  recordWorkItem: recordWorkItemMock,
  removeLifecycleBaselinedSession: removeLifecycleBaselinedSessionMock,
  writeReviewSourceSnapshot: writeReviewSourceSnapshotMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

const { githubSourceModule, tokenizeSearchQuery } =
  await import("../../src/event-sources/github.js");

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
    // Default: the session has already established its lifecycle baseline, so
    // lifecycle signals emit on transitions. The first-poll-suppression test
    // overrides this to an empty set.
    readLifecycleBaselinedSessionsMock.mockReturnValue(new Set(["api-a1b2"]));
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
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
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

  it("backs off GitHub polling on rate limit without mutating snapshots or work items", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T10:00:00.000Z"));
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
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        ["api-a1b2", existingSnapshot],
        ["stale-session", new Map()],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    const rateLimitError = Object.assign(new Error("GraphQL: API rate limit already exceeded"), {
      stderr: JSON.stringify({
        errors: [{ message: "API rate limit already exceeded" }],
        data: { rateLimit: { resetAt: "2026-06-19T10:05:00.000Z" } },
      }),
    });
    ghMock.mockRejectedValueOnce(rateLimitError);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
        query: "repo:acme/api",
      },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "GitHub rate limit hit; polling paused until 2026-06-19T10:05:00.000Z",
      ),
    );
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(recordWorkItemMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4 * 60_000);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(recordWorkItemMock).not.toHaveBeenCalled();

    handle.stop();
  });

  it("disables GitHub polling after bad credentials without repeated warnings", async () => {
    vi.useFakeTimers();
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        ["api-a1b2", new Map()],
        ["stale-session", new Map()],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    const authError = Object.assign(new Error("HTTP 401: Bad credentials"), {
      stderr: "Bad credentials",
    });
    ghMock.mockRejectedValueOnce(authError);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
        query: "repo:acme/api",
      },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logSpurEventMock).toHaveBeenCalledTimes(1);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "source.auth.disabled",
        message: expect.stringContaining("Bad credentials"),
      }),
    );
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(recordWorkItemMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logSpurEventMock).toHaveBeenCalledTimes(1);
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(recordWorkItemMock).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
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
    ghMock.mockResolvedValueOnce("[]");

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
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
    ghMock.mockResolvedValueOnce("[]");

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
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
    ghMock.mockResolvedValueOnce("[]");

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
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

  it("emits an unseen review comment without recording it (consult-only)", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    trackSeenComments();
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
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: 7001, body: "tighten this", path: "src/a.ts", line: 12, user: { login: "alice" } },
      ]),
    );
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce("[]");

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "review-comment:7001" })],
      }),
    );
    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("suppresses a review comment whose review-comment key is already seen", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession()]);
    trackSeenComments(["review-comment:7001"]);
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
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: 7001, body: "our own reply", path: "src/a.ts", line: 12, user: { login: "spur" } },
      ]),
    );
    ghMock.mockResolvedValueOnce("[]");
    ghMock.mockResolvedValueOnce("[]");

    const emit = vi.fn();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    handle.stop();
  });

  function prView(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      number: 42,
      title: "Fix CI alert",
      url: "https://github.com/acme/api/pull/42",
      reviewDecision: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ name: "workflow", conclusion: "SUCCESS" }],
      isDraft: false,
      state: "OPEN",
      ...overrides,
    });
  }

  // gh call order for a bound PR session in collectSignals:
  // pr view, pr checks, review comments, issue comments, reviews.
  function mockLifecyclePoll(prViewJson: string, reviewsJson = "[]"): void {
    ghMock
      .mockResolvedValueOnce(prViewJson)
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(reviewsJson);
  }

  beforeEach(() => {
    ghMock.mockReset();
  });

  async function startLifecycle(emit: ReturnType<typeof vi.fn>) {
    return githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
  }

  it("emits github:ready_for_review when a draft PR becomes ready", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ isDraft: false }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:ready_for_review",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "ready_for_review" })],
      }),
    );
    handle.stop();
  });

  it("does not emit github:ready_for_review while the PR is a draft", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ isDraft: true }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:ready_for_review", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as unknown;
    expect(snapshot).toBeInstanceOf(Map);
    if (snapshot instanceof Map) {
      expect(snapshot.has("ready_for_review")).toBe(false);
    }
    handle.stop();
  });

  it("emits github:approved once per reviewer and not again on a second poll", async () => {
    vi.useFakeTimers();
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    // First poll, then the second poll fired by the interval timer.
    mockLifecyclePoll(prView(), JSON.stringify([{ state: "APPROVED", user: { login: "alice" } }]));
    mockLifecyclePoll(prView(), JSON.stringify([{ state: "APPROVED", user: { login: "alice" } }]));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:approved",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "approved:alice" })],
      }),
    );

    emit.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(emit).not.toHaveBeenCalledWith("github:approved", expect.anything());
    handle.stop();
  });

  it("emits github:approved per distinct reviewer only", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { state: "APPROVED", user: { login: "alice" } },
        { state: "APPROVED", user: { login: "alice" } },
        { state: "COMMENTED", user: { login: "bob" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    const approvedCalls = emit.mock.calls.filter((call) => call[0] === "github:approved");
    expect(approvedCalls).toHaveLength(1);
    expect(approvedCalls[0]?.[1]).toMatchObject({
      signals: [expect.objectContaining({ key: "approved:alice" })],
    });
    handle.stop();
  });

  it("keeps deleted-account approvals distinct and uses real logins verbatim", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 111, state: "APPROVED", user: null },
        { id: 222, state: "APPROVED", user: { login: null } },
        { id: 333, state: "APPROVED", user: { login: "carol" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    const approvedCalls = emit.mock.calls.filter((call) => call[0] === "github:approved");
    expect(approvedCalls).toHaveLength(1);
    const signals = (approvedCalls[0]?.[1] as { signals: Array<{ key: string; text: string }> })
      .signals;
    const keys = signals.map((signal) => signal.key);
    expect(keys).toContain("approved:deleted-user-111");
    expect(keys).toContain("approved:deleted-user-222");
    expect(keys).toContain("approved:carol");
    expect(new Set(keys).size).toBe(keys.length);
    const carol = signals.find((signal) => signal.key === "approved:carol");
    expect(carol?.text).toBe("carol approved this PR.");
    const ghost = signals.find((signal) => signal.key === "approved:deleted-user-111");
    expect(ghost?.text).toBe("A former user approved this PR.");
    handle.stop();
  });

  it("does not fetch approvals once the PR is terminal", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    // gh call order for a terminal PR: pr view, pr checks, review comments,
    // issue comments. The reviews endpoint is skipped, so no 5th response.
    ghMock
      .mockResolvedValueOnce(prView({ state: "MERGED" }))
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:approved", expect.anything());
    const reviewsCall = ghMock.mock.calls.find((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("/reviews")),
    );
    expect(reviewsCall).toBeUndefined();
    handle.stop();
  });

  it("emits github:merged when the PR state is MERGED and not github:closed", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ state: "MERGED" }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:merged",
      expect.objectContaining({ signals: [expect.objectContaining({ key: "merged" })] }),
    );
    expect(emit).not.toHaveBeenCalledWith("github:closed", expect.anything());
    handle.stop();
  });

  it("emits github:closed when the PR state is CLOSED and not github:merged", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ state: "CLOSED" }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:closed",
      expect.objectContaining({ signals: [expect.objectContaining({ key: "closed" })] }),
    );
    expect(emit).not.toHaveBeenCalledWith("github:merged", expect.anything());
    handle.stop();
  });

  it("does not re-emit github:merged on a second identical poll", async () => {
    vi.useFakeTimers();
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", new Map()]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ state: "MERGED" }));
    mockLifecyclePoll(prView({ state: "MERGED" }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith("github:merged", expect.anything());

    emit.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(emit).not.toHaveBeenCalledWith("github:merged", expect.anything());
    handle.stop();
  });

  it("skips polling a session whose snapshot already has merged", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          new Map([
            ["merged", { key: "merged", kind: "merged" as const, text: "PR #42 was merged." }],
          ]),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    // gh mock intentionally not primed: the terminal-skip guard must short-circuit
    // before collectSignals runs, so no gh call should occur.
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(ghMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    handle.stop();
  });

  it("skips polling a session whose snapshot already has closed", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          new Map([
            [
              "closed",
              {
                key: "closed",
                kind: "closed" as const,
                text: "PR #42 was closed without merging.",
              },
            ],
          ]),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(ghMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    handle.stop();
  });

  it("still polls an open session whose snapshot has a non-terminal kind", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          new Map([
            [
              "changes_requested",
              {
                key: "changes_requested",
                kind: "changes_requested" as const,
                text: "Changes requested on this PR.",
              },
            ],
          ]),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ state: "OPEN" }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(ghMock).toHaveBeenCalled();
    handle.stop();
  });

  it("suppresses already-true lifecycle state on the first poll, then emits transitions after baseline", async () => {
    // First poll: pre-existing session whose persisted snapshot predates
    // lifecycle keys (only a non-lifecycle ci_failed signal) and is NOT baselined.
    const legacySnapshot = new Map([
      [
        "ci_failed",
        {
          key: "ci_failed",
          kind: "ci_failed" as const,
          text: "CI is failing: old suite.",
        },
      ],
    ]);
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", legacySnapshot]]));
    readLifecycleBaselinedSessionsMock.mockReturnValue(new Set<string>());
    listSessionsMock.mockReturnValue([makeSession()]);
    // gh call order: pr view, pr checks, review comments, issue comments, reviews.
    // PR is already ready + approved, plus a freshly failing check.
    ghMock
      .mockResolvedValueOnce(
        prView({ statusCheckRollup: [{ name: "workflow", conclusion: "FAILURE" }] }),
      )
      .mockResolvedValueOnce(JSON.stringify([{ name: "workflow", state: "FAILURE" }]))
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(JSON.stringify([{ state: "APPROVED", user: { login: "alice" } }]));
    const emit = vi.fn();

    const firstHandle = await startLifecycle(emit);

    // Lifecycle state present in the snapshot is suppressed on the baseline poll.
    expect(emit).not.toHaveBeenCalledWith("github:ready_for_review", expect.anything());
    expect(emit).not.toHaveBeenCalledWith("github:approved", expect.anything());
    // The non-lifecycle changed signal still emits on the same poll.
    expect(emit).toHaveBeenCalledWith(
      "github:ci_failed",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "ci_failed" })],
      }),
    );
    // The session is recorded as baselined so the next poll emits transitions.
    expect(recordLifecycleBaselinedSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "pr-watch",
      "api-a1b2",
    );
    firstHandle.stop();

    // Second poll after a daemon restart: the baseline survived in the persistent
    // registry, and the persisted snapshot now carries the lifecycle keys observed
    // on the first poll (ready_for_review, approved) but not yet merged.
    ghMock.mockReset();
    emit.mockClear();
    const baselinedSnapshot = new Map([
      [
        "ready_for_review",
        {
          key: "ready_for_review",
          kind: "ready_for_review" as const,
          text: "PR is ready for review.",
        },
      ],
      [
        "approved:alice",
        {
          key: "approved:alice",
          kind: "approved" as const,
          text: "alice approved this PR.",
        },
      ],
    ]);
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", baselinedSnapshot]]));
    readLifecycleBaselinedSessionsMock.mockReturnValue(new Set(["api-a1b2"]));
    // Terminal PR: approval fetch is skipped, so only four gh calls.
    ghMock
      .mockResolvedValueOnce(prView({ state: "MERGED" }))
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");

    const secondHandle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:merged",
      expect.objectContaining({ signals: [expect.objectContaining({ key: "merged" })] }),
    );
    secondHandle.stop();
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
        emitExisting: false,
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

  it.each([
    ["malformed JSON", "not json"],
    [
      "malformed shape",
      JSON.stringify([
        {
          number: 7,
          title: "Work item",
          url: "https://github.com/acme/api/pull/7",
          repository: {},
        },
      ]),
    ],
  ])("does not emit work items from %s in gh search prs output", async (_name, raw) => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/api#1"]));
    ghMock.mockResolvedValueOnce(raw);
    const emit = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
        query: "repo:acme/api",
      },
      emit,
      signal: new AbortController().signal,
      logger,
    });

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("github:work_item.new", expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("work-item poll failed"));

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
        emitExisting: false,
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
    expect(argv).toContain("--draft=false");
    // A simple query is a single positional token.
    expect(argv[3]).toBe("repo:acme/api");
    expect(argv[4]).toBe("--state");

    handle.stop();
  });

  it("splits a multi-qualifier query with a quoted label into separate gh args", async () => {
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
        emitExisting: false,
        query: 'repo:intelas/intelas-web label:"🌞 Front"',
      },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const searchCall = ghMock.mock.calls.find((call) => call[1] === "search" && call[2] === "prs");
    expect(searchCall).toBeDefined();
    const argv = (searchCall ?? []).map(String);
    expect(argv).toContain("repo:intelas/intelas-web");
    expect(argv).toContain("label:🌞 Front");
    expect(argv).toContain("--draft=false");

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
        emitExisting: false,
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

  it("emits the existing backlog and records all when emitExisting is true", async () => {
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
        emitExisting: true,
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
    const workItemEmits = emit.mock.calls.filter((call) => call[0] === "github:work_item.new");
    expect(workItemEmits).toHaveLength(2);

    handle.stop();
  });

  it("caps first-poll emits but records every backlog item when emitExisting is true", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    readWorkItemRegistryMock.mockReturnValue(new Set(["legacy/old#3"]));
    const backlog = Array.from({ length: 13 }, (_, index) => ({
      number: index + 1,
      title: `Backlog ${index + 1}`,
      url: `https://github.com/acme/api/pull/${index + 1}`,
      repository: { nameWithOwner: "acme/api" },
    }));
    ghMock.mockResolvedValueOnce(JSON.stringify(backlog));
    const emit = vi.fn();

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: true,
        query: "repo:acme/api",
      },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const workItemEmits = emit.mock.calls.filter((call) => call[0] === "github:work_item.new");
    expect(workItemEmits).toHaveLength(10);
    const recordCalls = recordWorkItemMock.mock.calls.filter((call) => call[2] === "pr-watch");
    expect(recordCalls).toHaveLength(13);

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
        emitExisting: false,
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

describe("tokenizeSearchQuery", () => {
  it("returns a single token for a simple query", () => {
    expect(tokenizeSearchQuery("repo:ashugaev/spur")).toEqual(["repo:ashugaev/spur"]);
  });

  it("splits two bare qualifiers into separate tokens", () => {
    expect(tokenizeSearchQuery("repo:cli/cli label:bug")).toEqual(["repo:cli/cli", "label:bug"]);
  });

  it("keeps a quoted value with a space as one token and strips the quotes", () => {
    expect(tokenizeSearchQuery('repo:intelas/intelas-web label:"🌞 Front"')).toEqual([
      "repo:intelas/intelas-web",
      "label:🌞 Front",
    ]);
  });

  it("ignores extra, leading, and trailing whitespace", () => {
    expect(tokenizeSearchQuery("  repo:cli/cli   label:bug  ")).toEqual([
      "repo:cli/cli",
      "label:bug",
    ]);
  });
});
