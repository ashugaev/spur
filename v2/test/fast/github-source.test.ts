import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ghModule from "../../src/gh.js";
import type { ReviewSignal, ReviewSnapshot, SessionRecord } from "../../src/types.js";

const ghMock = vi.fn();
const ghTransportMock = vi.fn();
const listSessionsMock = vi.fn();
const readReviewSourceSnapshotsMock = vi.fn();
const writeReviewSourceSnapshotMock = vi.fn();
const deleteReviewSourceSnapshotMock = vi.fn();
const hasGitHubMergeConflictRestoreReplayMock = vi.fn();
const clearGitHubMergeConflictRestoreReplayMock = vi.fn();
const readWorkItemRegistryMock = vi.fn();
const recordWorkItemMock = vi.fn();
const readCommentSeenRegistryMock = vi.fn();
const readGitHubReviewPaginationMock = vi.fn();
const writeGitHubReviewPaginationMock = vi.fn();
const recordCommentSeenMock = vi.fn();
const readLifecycleBaselinedSessionsMock = vi.fn();
const recordLifecycleBaselinedSessionMock = vi.fn();
const removeLifecycleBaselinedSessionMock = vi.fn();
const logSpurEventMock = vi.fn();
const isGitWorktreeMock = vi.fn();
const hasRecentSessionUserActionMock = vi.fn();

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghTransportMock,
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
  readGitHubReviewPagination: readGitHubReviewPaginationMock,
  readLifecycleBaselinedSessions: readLifecycleBaselinedSessionsMock,
  readReviewSourceSnapshots: readReviewSourceSnapshotsMock,
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordCommentSeen: recordCommentSeenMock,
  recordLifecycleBaselinedSession: recordLifecycleBaselinedSessionMock,
  recordWorkItem: recordWorkItemMock,
  removeLifecycleBaselinedSession: removeLifecycleBaselinedSessionMock,
  writeReviewSourceSnapshot: writeReviewSourceSnapshotMock,
  writeGitHubReviewPagination: writeGitHubReviewPaginationMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: vi.fn(),
  readRemoteUrls: vi.fn().mockResolvedValue(new Map([["origin", "git@github.com:acme/api.git"]])),
  isGitWorktree: isGitWorktreeMock,
}));
vi.mock("../../src/user-action-log.js", () => ({
  hasRecentSessionUserAction: hasRecentSessionUserActionMock,
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

const { githubSourceModule, tokenizeSearchQuery } =
  await import("../../src/event-sources/github.js");
const { GH_POLL_MIN_GRAPHQL_REMAINING, _resetGhUsageForTests, recordGraphqlBudget } =
  await import("../../src/gh.js");

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    workspaceId: overrides.workspaceId ?? "api-a1b2",
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

// `SessionRecord.pr` is optional but not nullable (exactOptionalPropertyTypes),
// so an unbound session can't be built via `makeSession({ pr: undefined })` —
// the property must be absent, not present-and-undefined.
function makeUnboundSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const { pr: _pr, ...session } = makeSession(overrides);
  return session;
}

// The source polls on a node:timers interval, which vitest fake timers do not
// patch here, so interval ticks never fire under advanceTimersByTimeAsync. Drive
// extra polls deterministically via handle.runOnStart() (exposed when runOnStart
// is true) and flush the fire-and-forget pollCycle promise chain between calls.
const flushPollCycle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Builds the on-disk/in-memory envelope shape `readReviewSourceSnapshotsMock`
// now returns per session. `prNumber` defaults to 42 to match `makeSession`'s
// default `pr.number` so the stored snapshot is treated as the baseline for
// the bound PR unless a test deliberately wants a mismatch (rebind/legacy).
function storedSnapshot(signals: ReviewSignal[], prNumber: number | null = 42): ReviewSnapshot {
  return { prNumber, signals: new Map(signals.map((signal) => [signal.key, signal])) };
}

// Builds a GraphQL envelope carrying a "PR not found" style error for the
// review batch alias shape (review-providers/github.ts buildGitHubReviewBatchQuery:
// aliases are a0, a1, ... in target order). `withPath` attaches a `path` naming the
// alias, which routes the message through gqlErrorsByAlias (pr-lookup.ts:260-287) so
// only that alias's session sees it; omitting it forces the joined-message fallback
// (graphqlEnvelopeErrorMessage, review-providers/github.ts:733-739) onto every alias
// in the batch — the batch-poisoning shape.
function notFoundEnvelope(
  prNumber: number,
  opts: { withPath?: boolean; alias?: string } = {},
): string {
  const alias = opts.alias ?? "a0";
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
      r: { [alias]: null },
    },
    errors: [
      {
        type: "NOT_FOUND",
        ...(opts.withPath ? { path: ["r", alias] } : {}),
        message: `Could not resolve to a PullRequest with the number of ${prNumber}.`,
      },
    ],
  });
}

function parseMockJson(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}

function graphqlAuthor(user: unknown): { login: unknown } | null {
  return typeof user === "object" && user !== null && "login" in user
    ? { login: user.login }
    : null;
}

async function legacyGhAdapter(cwd: string, ...args: string[]): Promise<string> {
  if (args[0] !== "api" || !args.includes("graphql")) {
    return ghMock(cwd, ...args) as Promise<string>;
  }
  const prRaw = await ghMock(cwd, "pr", "view");
  const parsedPr = parseMockJson(prRaw, null);
  const pr = Array.isArray(parsedPr) ? parsedPr[0] : parsedPr;
  if (typeof pr !== "object" || pr === null) return JSON.stringify({ data: { r: { a0: null } } });
  const record = pr as Record<string, unknown>;
  const checks = parseMockJson(await ghMock(cwd, "pr", "checks"), []);
  const reviewComments = parseMockJson(await ghMock(cwd, "api", "pulls/comments"), []);
  const issueComments = parseMockJson(await ghMock(cwd, "api", "issues/comments"), []);
  const terminal = record.state === "MERGED" || record.state === "CLOSED";
  const reviews = terminal ? [] : parseMockJson(await ghMock(cwd, "api", "pulls/reviews"), []);
  const rollup = Array.isArray(record.statusCheckRollup) ? record.statusCheckRollup : checks;
  const mapAuthor = (value: unknown): Record<string, unknown> => {
    const item = value as Record<string, unknown>;
    return { ...item, databaseId: item.id, author: graphqlAuthor(item.user) };
  };
  const node = {
    ...record,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: Array.isArray(rollup) ? rollup : [] },
            },
          },
        },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          isResolved: false,
          comments: {
            nodes: Array.isArray(reviewComments) ? reviewComments.map(mapAuthor) : [],
          },
        },
      ],
    },
    comments: { nodes: Array.isArray(issueComments) ? issueComments.map(mapAuthor) : [] },
    reviews: { nodes: Array.isArray(reviews) ? reviews.map(mapAuthor) : [] },
  };
  const branchQuery = args.some((arg) => arg.includes("pullRequests(headRefName"));
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
      r: { a0: branchQuery ? { nodes: [node] } : node },
    },
  });
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
    _resetGhUsageForTests();
    ghTransportMock.mockImplementation(legacyGhAdapter);
    hasGitHubMergeConflictRestoreReplayMock.mockReturnValue(false);
    readWorkItemRegistryMock.mockReturnValue(new Set());
    readCommentSeenRegistryMock.mockReturnValue(new Set());
    readGitHubReviewPaginationMock.mockReturnValue(new Map());
    // Default: the session has already established its lifecycle baseline, so
    // lifecycle signals emit on transitions. The first-poll-suppression test
    // overrides this to an empty set.
    readLifecycleBaselinedSessionsMock.mockReturnValue(new Set(["api-a1b2"]));
    // Default: sessions have a valid git worktree so polling proceeds. The
    // dead-worktree tests override this per case.
    isGitWorktreeMock.mockResolvedValue(true);
    hasRecentSessionUserActionMock.mockReturnValue(false);
  });

  afterEach(() => {
    _resetGhUsageForTests();
    vi.useRealTimers();
  });

  it("keeps the existing snapshot when gh pr view fails transiently", async () => {
    const existingSnapshot = storedSnapshot([
      {
        key: "ci_failed",
        kind: "ci_failed" as const,
        text: "CI is failing: runtime suite.",
      },
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
    const existingSnapshot = storedSnapshot([
      {
        key: "ci_failed",
        kind: "ci_failed" as const,
        text: "CI is failing: runtime suite.",
      },
    ]);
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        ["api-a1b2", existingSnapshot],
        ["stale-session", storedSnapshot([])],
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
        ["api-a1b2", storedSnapshot([])],
        ["stale-session", storedSnapshot([])],
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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

  it("does not spawn a git worktree probe on the review-poll hot path", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession()]);
    isGitWorktreeMock.mockResolvedValue(false);
    mockLifecyclePoll(prView());
    mockLifecyclePoll(prView());
    mockLifecyclePoll(prView());
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();
    handle.runOnStart?.();
    await flushPollCycle();
    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghMock).toHaveBeenCalledTimes(15);
    expect(isGitWorktreeMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    const deadWorktreeEvents = logSpurEventMock.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as { event?: string }).event === "source.poll.dead_worktree",
    );
    expect(deadWorktreeEvents).toHaveLength(0);
    handle.stop();
  });

  it("polls a session whose worktree is a valid git repository without a dead-worktree warning", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView());
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghMock).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("worktree missing or not a git repository"),
    );
    expect(logSpurEventMock).not.toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({ event: "source.poll.dead_worktree" }),
    );
    handle.stop();
  });

  it("still polls a stale-parked session", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([
      makeSession({ status: "stopped", stopReason: "stale_timeout" }),
    ]);
    mockLifecyclePoll(prView());
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghMock).toHaveBeenCalled();
    handle.stop();
  });

  it("does not poll a killed session", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession({ status: "killed" })]);
    mockLifecyclePoll(prView());
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("uses structured session state instead of the git worktree probe", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    isGitWorktreeMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockLifecyclePoll(prView());
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();
    expect(ghMock).toHaveBeenCalled();
    expect(isGitWorktreeMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does not emit dead-worktree events from review polling", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    isGitWorktreeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    mockLifecyclePoll(prView());
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();
    expect(isGitWorktreeMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logSpurEventMock).not.toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({ event: "source.poll.dead_worktree" }),
    );
    handle.stop();
  });

  it("keeps retrying a transient poll failure past its backoff window and does not treat it as a dead worktree", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock.mockRejectedValue(new Error("gh offline"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    // A non-classified error is retried past its transient backoff window
    // (SESSION_POLL_BACKOFF_BASE_MS = 120_000ms), not on every poll.
    handle.runOnStart?.();
    await flushPollCycle();
    vi.setSystemTime(new Date(Date.now() + 120_001));
    handle.runOnStart?.();
    await flushPollCycle();
    vi.setSystemTime(new Date(Date.now() + 240_001));
    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghMock).toHaveBeenCalledTimes(3);
    expect(logSpurEventMock).not.toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({ event: "source.poll.dead_worktree" }),
    );
    handle.stop();
  });

  it("does not emit ci_failed when the GitHub rollup is successful with skipped rows", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(emit).not.toHaveBeenCalledWith("github:ci_failed", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("ci_failed")).toBe(false);

    handle.stop();
  });

  it("emits an unseen issue comment without recording it seen (consult-only)", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "comment:9001" })],
      }),
    );
    // Recording seen at generation time dropped the comment from the next snapshot,
    // letting the trigger retry prune() discard it on a busy worker. Dedup is the
    // snapshot's job now, so generation must never mark issue comments seen.
    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does not re-emit issue comments observed on a previous poll", async () => {
    trackSeenComments(["9001"]);
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot([
            {
              key: "comment:9001",
              kind: "comment" as const,
              text: 'New PR comment from alice: "first pass please"',
            },
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    handle.stop();
  });

  it("emits only the issue comment absent from the previous snapshot", async () => {
    trackSeenComments();
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot([
            {
              key: "comment:9001",
              kind: "comment" as const,
              text: 'New PR comment from alice: "first pass please"',
            },
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "comment:9002" })],
      }),
    );
    handle.stop();
  });

  it("emits an unseen review comment without recording it (consult-only)", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });
  }

  it("emits github:ready_for_review when a draft PR becomes ready", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ isDraft: true }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:ready_for_review", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("ready_for_review")).toBe(false);
    handle.stop();
  });

  it("emits github:approved once per reviewer and not again on a second poll", async () => {
    vi.useFakeTimers();
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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

  it("emits a comment signal for a COMMENTED review body with no inline comments", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 555, state: "COMMENTED", body: "please rename the helper", user: { login: "bob" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [
          expect.objectContaining({
            key: "review:555",
            text: 'New review from bob: "please rename the helper"',
          }),
        ],
      }),
    );
    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("ignores a review with an empty body and no approval", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([{ id: 556, state: "COMMENTED", body: "", user: { login: "bob" } }]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("review:556")).toBe(false);
    handle.stop();
  });

  it("emits only the approval, not a body signal, for an APPROVED review with a body", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 557, state: "APPROVED", body: "LGTM, one nit inline", user: { login: "carol" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:approved",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "approved:carol" })],
      }),
    );
    // An APPROVED body must not emit a non-lifecycle comment: it would bypass first-run
    // baseline suppression and re-surface a stale approval on a session's first poll.
    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("review:557")).toBe(false);
    handle.stop();
  });

  it("ignores a DISMISSED review body", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 558, state: "DISMISSED", body: "was blocking, now moot", user: { login: "carol" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("review:558")).toBe(false);
    handle.stop();
  });

  it("does not re-fire a review body when its only change is a state transition", async () => {
    vi.useFakeTimers();
    // Same review id + body across polls; state flips COMMENTED -> DISMISSED. Because
    // state is absent from the dedup text and DISMISSED is filtered, no re-emit fires.
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 559, state: "COMMENTED", body: "take a look", user: { login: "dan" } },
      ]),
    );
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 559, state: "DISMISSED", body: "take a look", user: { login: "dan" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "review:559" })],
      }),
    );

    emit.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    handle.stop();
  });

  it("emits a comment signal for a CHANGES_REQUESTED review body", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 600, state: "CHANGES_REQUESTED", body: "blocks merge", user: { login: "dave" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({
        signals: [
          expect.objectContaining({
            key: "review:600",
            text: 'New review from dave: "blocks merge"',
          }),
        ],
      }),
    );
    handle.stop();
  });

  it("ignores a whitespace-only review body", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([{ id: 601, state: "COMMENTED", body: "   \n  ", user: { login: "dave" } }]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("review:601")).toBe(false);
    handle.stop();
  });

  it("ignores a body-only review with an unrecognized (null) state", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([{ id: 602, state: null, body: "drive-by note", user: { login: "dave" } }]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:comment", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("review:602")).toBe(false);
    handle.stop();
  });

  it("keeps distinct review bodies from one author (not deduped like approvals)", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(
      prView(),
      JSON.stringify([
        { id: 700, state: "COMMENTED", body: "first round", user: { login: "erin" } },
        { id: 701, state: "COMMENTED", body: "second round", user: { login: "erin" } },
      ]),
    );
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    const commentCall = emit.mock.calls.find((call) => call[0] === "github:comment");
    const keys = (commentCall?.[1] as { signals: Array<{ key: string }> }).signals.map(
      (signal) => signal.key,
    );
    expect(keys).toEqual(["review:700", "review:701"]);
    handle.stop();
  });

  it("writes the issue comment into the snapshot so retry prune() retains it", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    trackSeenComments();
    ghMock
      .mockResolvedValueOnce(prView())
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(
        JSON.stringify([{ id: 9100, body: "please rebase", user: { login: "frank" } }]),
      )
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    // The comment must persist in the written snapshot. prune() drops batch signals
    // absent from this snapshot, so a comment missing here is lost on a busy worker.
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.signals.has("comment:9100")).toBe(true);
    expect(recordCommentSeenMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does not fetch approvals once the PR is terminal", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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

  it("collapses two tracked PRs in one repo to one GraphQL invocation", async () => {
    const second = makeSession({
      id: "api-c3d4",
      workspaceId: "api-c3d4",
      worktreePath: "/tmp/spur-worktrees/api-c3d4",
      pr: {
        number: 43,
        repo: "acme/api",
        url: "https://github.com/acme/api/pull/43",
      },
    });
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession(), second]);
    const node = (number: number) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/api/pull/${number}`,
      reviewDecision: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      isDraft: false,
      state: "OPEN",
      commits: { nodes: [] },
      reviewThreads: { nodes: [] },
      reviews: { nodes: [] },
      comments: { nodes: [] },
    });
    ghTransportMock.mockReset().mockResolvedValueOnce(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
          r: { a0: node(42), a1: node(43) },
        },
      }),
    );

    const handle = await startLifecycle(vi.fn());

    expect(ghTransportMock).toHaveBeenCalledTimes(1);
    expect(ghTransportMock.mock.calls[0]).toEqual(
      expect.arrayContaining(["api", "graphql", "-F", "n0=42", "-F", "n1=43"]),
    );
    expect(ghTransportMock.mock.calls[0]).not.toContain("view");
    expect(ghTransportMock.mock.calls[0]).not.toContain("checks");
    expect(writeReviewSourceSnapshotMock).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("preserves an unbound snapshot when the pull-request connection is malformed", async () => {
    const existing = storedSnapshot([
      { key: "changes_requested", kind: "changes_requested", text: "Changes requested." },
    ]);
    const { pr: _pr, ...unbound } = makeSession();
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([[unbound.id, existing]]));
    listSessionsMock.mockReturnValue([unbound]);
    ghTransportMock.mockReset().mockResolvedValueOnce(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_800, resetAt: "2099-06-19T11:00:00.000Z" },
          r: { a0: null },
        },
      }),
    );

    const handle = await startLifecycle(vi.fn());

    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("spends no review-poll call and preserves snapshots below the GraphQL reserve", async () => {
    const existing = storedSnapshot([
      { key: "changes_requested", kind: "changes_requested", text: "Changes requested." },
    ]);
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", existing]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    recordGraphqlBudget(GH_POLL_MIN_GRAPHQL_REMAINING - 1, Date.now() + 60_000, Date.now());

    const handle = await startLifecycle(vi.fn());

    expect(ghTransportMock).not.toHaveBeenCalled();
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("emits github:merged when the PR state is MERGED and not github:closed", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ state: "MERGED" }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:merged",
      // Key is scoped to the PR it was collected from (`session.pr.number` is 42 for
      // the default `makeSession()`); `kind` stays the unscoped "merged".
      expect.objectContaining({ signals: [expect.objectContaining({ key: "merged:42" })] }),
    );
    expect(emit).not.toHaveBeenCalledWith("github:closed", expect.anything());
    handle.stop();
  });

  it("emits github:closed when the PR state is CLOSED and not github:merged", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    mockLifecyclePoll(prView({ state: "CLOSED" }));
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).toHaveBeenCalledWith(
      "github:closed",
      expect.objectContaining({ signals: [expect.objectContaining({ key: "closed:42" })] }),
    );
    expect(emit).not.toHaveBeenCalledWith("github:merged", expect.anything());
    handle.stop();
  });

  it("does not re-emit github:merged on a second identical poll", async () => {
    vi.useFakeTimers();
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", storedSnapshot([])]]));
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

  it("skips polling a session whose snapshot already has merged for the bound PR", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot([
            { key: "merged:42", kind: "merged" as const, text: "PR #42 was merged." },
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
    expect(ghTransportMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    handle.stop();
  });

  it("skips polling a session whose snapshot already has closed for the bound PR", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot([
            {
              key: "closed:42",
              kind: "closed" as const,
              text: "PR #42 was closed without merging.",
            },
          ]),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(ghMock).not.toHaveBeenCalled();
    expect(ghTransportMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    handle.stop();
  });

  it("still polls an open session whose snapshot has a non-terminal kind", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot([
            {
              key: "changes_requested",
              kind: "changes_requested" as const,
              text: "Changes requested on this PR.",
            },
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

  it("keeps delivering after a session rebinds off a terminal PR (the incident)", async () => {
    // Session was bound to #3960; the poller observed it close and wrote the
    // scoped terminal key `closed:3960`. `spur slots --link pr=...` then rebound
    // the session to #3963 — the real incident this scoping fixes. The stale
    // terminal snapshot for #3960 must never mute the session for its new PR.
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot(
            [
              {
                key: "closed:3960",
                kind: "closed" as const,
                text: "PR #3960 was closed without merging.",
              },
            ],
            3960,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([
      makeSession({
        pr: { number: 3963, repo: "acme/api", url: "https://github.com/acme/api/pull/3963" },
      }),
    ]);
    mockLifecyclePoll(
      prView({ number: 3963, url: "https://github.com/acme/api/pull/3963", state: "OPEN" }),
    );
    const emit = vi.fn();

    // runOnStart:true + handle.runOnStart() drives a second, deterministic poll:
    // the node:timers interval this source polls on is not patched by vitest's
    // fake timers, so advanceTimersByTimeAsync would never actually fire a second
    // tick here (see flushPollCycle's doc comment above).
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghMock).toHaveBeenCalled();
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.prNumber).toBe(3963);
    expect(snapshot.signals.has("closed:3960")).toBe(false);

    // A second poll with fresh activity on #3963 is delivered — the session was
    // never muted by the PR it rebound away from.
    ghMock
      .mockResolvedValueOnce(
        prView({ number: 3963, url: "https://github.com/acme/api/pull/3963", state: "OPEN" }),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(
        JSON.stringify([{ id: 9300, body: "please look", user: { login: "grace" } }]),
      )
      .mockResolvedValueOnce("[]");
    emit.mockClear();
    handle.runOnStart?.();
    await flushPollCycle();

    expect(emit).toHaveBeenCalledWith(
      "github:comment",
      expect.objectContaining({ signals: [expect.objectContaining({ key: "comment:9300" })] }),
    );
    handle.stop();
  });

  it("migrates a legacy bare-array snapshot silently, without replaying its lifecycle state", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          // Legacy on-disk shape (bare array) parses to `prNumber: null`, which
          // carries no PR identity and matches no scoped terminal key — the stale
          // bare `merged` key must never authorize a skip.
          storedSnapshot(
            [{ key: "merged", kind: "merged" as const, text: "PR #42 was merged." }],
            null,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock
      .mockResolvedValueOnce(prView({ state: "MERGED" }))
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(ghMock).toHaveBeenCalled();
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.prNumber).toBe(42);
    expect(snapshot.signals.has("merged:42")).toBe(true);
    // `prNumber: null` mismatches 42, so this is a first observation: the
    // already-true `merged` lifecycle state is baselined away, not replayed.
    expect(emit).not.toHaveBeenCalledWith("github:merged", expect.anything());
    handle.stop();
  });

  it("re-baselines after a PR-number reset without replaying an identical-text signal", async () => {
    // Session rebinds from PR #42 to PR #99; #99 also has changes requested, so
    // the signal text is byte-identical. Only the PR-number mismatch — not the
    // text — must decide this is a first observation of #99, not a repeat.
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot(
            [
              {
                key: "changes_requested",
                kind: "changes_requested" as const,
                text: "Changes requested in review.",
              },
            ],
            42,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([
      makeSession({
        pr: { number: 99, repo: "acme/api", url: "https://github.com/acme/api/pull/99" },
      }),
    ]);
    ghMock
      .mockResolvedValueOnce(
        prView({
          number: 99,
          url: "https://github.com/acme/api/pull/99",
          reviewDecision: "CHANGES_REQUESTED",
        }),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(emit).not.toHaveBeenCalledWith("github:changes_requested", expect.anything());
    const snapshot = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(snapshot.prNumber).toBe(99);
    expect(snapshot.signals.has("changes_requested")).toBe(true);
    handle.stop();
  });

  it("replays the reset PR's already-true state when runOnStart requests a replay", async () => {
    // Same PR-number reset as above, but `runOnStart: true` means the caller
    // explicitly wants current state replayed: identity (not text) decided this
    // was a first observation, and `emitInitial` decides a first observation emits.
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot(
            [
              {
                key: "changes_requested",
                kind: "changes_requested" as const,
                text: "Changes requested in review.",
              },
            ],
            42,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([
      makeSession({
        pr: { number: 99, repo: "acme/api", url: "https://github.com/acme/api/pull/99" },
      }),
    ]);
    ghMock
      .mockResolvedValueOnce(
        prView({
          number: 99,
          url: "https://github.com/acme/api/pull/99",
          reviewDecision: "CHANGES_REQUESTED",
        }),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();

    expect(emit).toHaveBeenCalledWith(
      "github:changes_requested",
      expect.objectContaining({ signals: [expect.objectContaining({ key: "changes_requested" })] }),
    );
    handle.stop();
  });

  it("polls an unbound session despite a terminal snapshot recorded for a prior PR", async () => {
    // Decision 2: a snapshot's own prNumber is never local authority for "the
    // current PR" — only session.pr is, and only when it exists. A session with
    // no binding must always be polled so auto-discovery of a fresh PR is never
    // muted by a stale terminal snapshot.
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-a1b2",
          storedSnapshot(
            [
              {
                key: "closed:42",
                kind: "closed" as const,
                text: "PR #42 was closed without merging.",
              },
            ],
            42,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeUnboundSession()]);
    ghMock.mockResolvedValueOnce("[]");
    const emit = vi.fn();

    const handle = await startLifecycle(emit);

    expect(ghMock).toHaveBeenCalled();
    handle.stop();
  });

  it("suppresses already-true lifecycle state on the first poll, then emits transitions after baseline", async () => {
    // First poll: pre-existing session whose persisted snapshot predates
    // lifecycle keys (only a non-lifecycle ci_failed signal) and is NOT baselined.
    const legacySnapshot = storedSnapshot([
      {
        key: "ci_failed",
        kind: "ci_failed" as const,
        text: "CI is failing: old suite.",
      },
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
    const baselinedSnapshot = storedSnapshot([
      {
        key: "ready_for_review",
        kind: "ready_for_review" as const,
        text: "PR is ready for review.",
      },
      {
        key: "approved:alice",
        kind: "approved" as const,
        text: "alice approved this PR.",
      },
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
      expect.objectContaining({ signals: [expect.objectContaining({ key: "merged:42" })] }),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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

  it("passes --draft=true when the source config opts into draft polling", async () => {
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
        draft: true,
      },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    const searchCall = ghMock.mock.calls.find((call) => call[1] === "search" && call[2] === "prs");
    expect(searchCall).toBeDefined();
    const argv = (searchCall ?? []).map(String);
    expect(argv).toContain("--draft=true");
    expect(argv).not.toContain("--draft=false");

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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
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

  describe("adaptive poll", () => {
    // These tests drive the REAL production gate: the `startInterval` tick at
    // github.ts's `if (!shouldPollThisTick()) return;`. That interval is created via
    // `node:timers`' own `setInterval`, which vitest's fake timers do not intercept
    // (verified empirically: neither a full `vi.useFakeTimers()` nor an explicit
    // `toFake: ["setInterval", "clearInterval"]` list makes a directly-imported
    // `node:timers` callback fire under `vi.advanceTimersByTimeAsync`). So `intervalMs`
    // here is a small REAL duration and ticks are awaited with real waits, while `Date`
    // stays faked and frozen (only moved via explicit `vi.setSystemTime`) so the
    // adaptive-window math above the tick is fully deterministic. `runOnStart: false`
    // is used so the harness's own ungated startup poll (`await pollCycle(false)` in
    // `start()`) seeds `attemptedSessionIds`/snapshots once, and every poll after that
    // is driven exclusively through the real gated interval callback.
    const REAL_INTERVAL_MS = 20;

    function queuePollResponse(checksState: string): void {
      ghMock.mockResolvedValueOnce(
        prView({ statusCheckRollup: [{ name: "check", state: checksState }] }),
      );
      ghMock.mockResolvedValueOnce(JSON.stringify([{ name: "check", state: checksState }]));
      ghMock.mockResolvedValueOnce("[]");
      ghMock.mockResolvedValueOnce("[]");
      ghMock.mockResolvedValueOnce("[]");
    }

    async function waitForGhCallCount(target: number, timeoutMs = 4000): Promise<void> {
      const stepMs = 10;
      let waited = 0;
      while (ghMock.mock.calls.length < target) {
        if (waited >= timeoutMs) {
          throw new Error(
            `timed out waiting for ghMock call count >= ${target}, saw ${ghMock.mock.calls.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        waited += stepMs;
      }
    }

    async function waitForTransportCallCount(target: number, timeoutMs = 4000): Promise<void> {
      const stepMs = 10;
      let waited = 0;
      while (ghTransportMock.mock.calls.length < target) {
        if (waited >= timeoutMs) {
          throw new Error(
            `timed out waiting for gh transport call count >= ${target}, saw ${ghTransportMock.mock.calls.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        waited += stepMs;
      }
    }

    async function assertGhCallCountStable(
      count: number,
      durationMs = REAL_INTERVAL_MS * 8,
    ): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      expect(ghMock).toHaveBeenCalledTimes(count);
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
    });

    it("polls every interval tick when adaptivePoll is not configured", async () => {
      queuePollResponse("SUCCESS");
      queuePollResponse("SUCCESS");
      queuePollResponse("SUCCESS");

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      // Seeded by the ungated startup poll in start().
      expect(ghMock).toHaveBeenCalledTimes(5);

      // Both subsequent cycles run only through the real gated interval tick.
      await waitForGhCallCount(10);
      await waitForGhCallCount(15);

      handle.stop();
    });

    it("polls an in-window tick when the last cycle saw a non-terminal CI check", async () => {
      queuePollResponse("IN_PROGRESS");
      queuePollResponse("IN_PROGRESS");

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      // Well inside the slow window (Date never advanced), but the last cycle's CI
      // was non-terminal, so the real gated tick polls anyway.
      await waitForGhCallCount(10);

      handle.stop();
    });

    it("goes quiet in-window once CI settles with no pending session, then polls again past the slow window", async () => {
      queuePollResponse("SUCCESS");

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      // Still inside the slow window: settled CI, session already attempted, no
      // activity — real ticks keep firing but must stay suppressed.
      await assertGhCallCountStable(5);

      // Past the slow window: the deadline alone re-arms the real gated tick.
      queuePollResponse("SUCCESS");
      vi.setSystemTime(new Date("2026-07-30T00:10:01.000Z"));
      await waitForGhCallCount(10);

      handle.stop();
    });

    it("polls in-window on recent session activity, then quiets again once activity ages out", async () => {
      queuePollResponse("SUCCESS");

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      hasRecentSessionUserActionMock.mockReturnValue(true);
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(10);

      hasRecentSessionUserActionMock.mockReturnValue(false);
      await assertGhCallCountStable(10);

      handle.stop();
    });

    it("forces a poll for a brand-new session mid-window even when the tracked session is quiet", async () => {
      queuePollResponse("SUCCESS");

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      // A brand-new session appears mid-window: never attempted, forces a real poll.
      const newSession = makeSession({
        id: "api-c3d4",
        pr: { number: 43, repo: "acme/api", url: "https://github.com/acme/api/pull/43" },
      });
      listSessionsMock.mockReturnValue([makeSession(), newSession]);
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(10);

      handle.stop();
    });

    it("keeps a capacity-skipped session unattempted for the next in-window tick", async () => {
      listSessionsMock.mockReturnValue(
        Array.from({ length: 51 }, (_unused, index) =>
          makeSession({
            id: `api-${index}`,
            worktreePath: `/tmp/api-${index}`,
            pr: {
              number: index + 1,
              repo: "acme/api",
              url: `https://github.com/acme/api/pull/${index + 1}`,
            },
          }),
        ),
      );
      queuePollResponse("SUCCESS");
      queuePollResponse("SUCCESS");

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);
      await waitForGhCallCount(10);

      // Capacity drain ran inside the original slow window. It must not move
      // that deadline forward or the last targets would extend every cycle.
      vi.setSystemTime(new Date("2026-07-30T00:10:00.000Z"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(15);

      handle.stop();
    });

    it("keeps the CI-active hysteresis flag intact when a poll cycle is suppressed by a rate-limit cooldown", async () => {
      // Seed lastCycleCiActive = true via the ungated startup poll.
      queuePollResponse("IN_PROGRESS");
      const rateLimitError = Object.assign(new Error("GraphQL: API rate limit already exceeded"), {
        stderr: JSON.stringify({
          errors: [{ message: "API rate limit already exceeded" }],
          data: { rateLimit: { resetAt: "2026-07-30T00:05:00.000Z" } },
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
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger,
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      // Next real tick bypasses the deadline gate on lastCycleCiActive, but the poll
      // itself hits a rate limit on the very first gh call and enters cooldown before
      // ever reassigning lastCycleCiActive.
      await waitForGhCallCount(6);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("GitHub rate limit hit"));

      // While the cooldown holds, shouldSkipGitHubCalls suppresses every further tick.
      await assertGhCallCountStable(6);

      // Lift the cooldown but stay well short of the slow-window deadline (set from
      // the first cycle at T0+600_000ms = 00:10:00). If the suppressed cycle had
      // wrongly reset lastCycleCiActive to false, the deadline gate alone would keep
      // suppressing here and this would time out.
      vi.setSystemTime(new Date("2026-07-30T00:05:01.000Z"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(11);

      handle.stop();
    });

    it("preserves the CI-active hysteresis flag when a session poll errors instead of observing settled CI", async () => {
      // Seed lastCycleCiActive = true via the ungated startup poll.
      queuePollResponse("IN_PROGRESS");
      const logger = { info: vi.fn(), warn: vi.fn() };

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger,
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      // Next real tick bypasses the deadline gate on lastCycleCiActive, but the poll
      // itself hits a transient, non-rate-limit error on its very first gh call — the
      // cycle never gets to observe whether CI actually settled.
      ghMock.mockRejectedValueOnce(new Error("gh offline"));
      await waitForGhCallCount(6);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to poll"));

      // A buggy implementation would have reset lastCycleCiActive to false here (no
      // session in this cycle reported ciActive), so the deadline gate alone would
      // suppress every further tick. The flag must instead survive the errored cycle,
      // keeping ticks forced well inside the slow window (deadline stays at 00:10:00).
      // Past the session's own transient poll backoff (120_000ms base) so the next
      // tick's poll is not gated before it can retry.
      vi.setSystemTime(new Date(Date.now() + 120_001));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(11);

      handle.stop();
    });

    it("preserves the CI-active hysteresis flag when the batched request fails", async () => {
      // Seed lastCycleCiActive = true via the ungated startup poll.
      queuePollResponse("IN_PROGRESS");
      const logger = { info: vi.fn(), warn: vi.fn() };

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger,
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      ghTransportMock.mockRejectedValueOnce(new Error("gh: connection reset by peer"));
      await waitForTransportCallCount(2);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to poll"));

      // A buggy implementation would count the failed checks fetch as a clean
      // observation (no exception propagated) and reset lastCycleCiActive to false,
      // so the deadline gate alone would suppress every further tick. The flag must
      // instead survive, keeping ticks forced well inside the slow window (deadline
      // stays at 00:10:00).
      // Past the session's own transient poll backoff so the next tick is not gated.
      vi.setSystemTime(new Date(Date.now() + 120_001));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(10);

      handle.stop();
    });

    it("stops letting a persistently erroring session latch the CI-active hysteresis flag after a bounded number of consecutive failures", async () => {
      // A second, healthy session on a different repo is the actual
      // discriminator below: api-a1b2's own transient poll backoff empties it
      // out of every cycle it's ever observed in, regardless of the hysteresis
      // flag, so its own gh calls can't tell a buggy (unbounded) hysteresis
      // implementation from the fix. other-sess never backs off, so it only
      // gets (re-)polled when a full poll cycle actually runs.
      const otherSession = makeSession({
        id: "other-sess",
        workspaceId: "other-sess",
        pr: { number: 77, repo: "acme/other", url: "https://github.com/acme/other/pull/77" },
      });
      listSessionsMock.mockReturnValue([makeSession(), otherSession]);

      // Seed lastCycleCiActive = true via the ungated startup poll.
      queuePollResponse("IN_PROGRESS"); // api-a1b2
      queuePollResponse("SUCCESS"); // other-sess
      const logger = { info: vi.fn(), warn: vi.fn() };

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger,
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(10);

      // api-a1b2 errors on every subsequent cycle (e.g. a persistent
      // 404/permission issue) — never producing a clean observation. The first
      // CI_HYSTERESIS_ERROR_TOLERANCE (3) consecutive failures still preserve the
      // flag, each one bypassing the deadline gate for the next tick in turn. Each
      // failure also arms this session's own transient poll backoff (doubling from
      // 120_000ms), so Date must advance past it before the session is eligible
      // for the next attempt. other-sess is polled again in the same cycle each
      // time, adding 5 fresh gh calls of its own.
      ghMock.mockRejectedValueOnce(new Error("gh: permission denied"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(16);
      vi.setSystemTime(new Date(Date.now() + 120_001));
      ghMock.mockRejectedValueOnce(new Error("gh: permission denied"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(22);
      vi.setSystemTime(new Date(Date.now() + 240_001));
      ghMock.mockRejectedValueOnce(new Error("gh: permission denied"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(28);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to poll"));

      // The 4th consecutive failure for api-a1b2 exceeds the tolerance: it no
      // longer counts toward the hysteresis flag, so with other-sess reporting a
      // clean, inactive poll this same cycle, lastCycleCiActive drops to false.
      vi.setSystemTime(new Date(Date.now() + 480_001));
      ghMock.mockRejectedValueOnce(new Error("gh: permission denied"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(34);

      // api-a1b2's own transient backoff (armed for 960_000ms after the 4th
      // failure) now empties it out of every cycle regardless of the hysteresis
      // flag. other-sess is the discriminator: a buggy (unbounded)
      // implementation leaves lastCycleCiActive stuck true, which bypasses the
      // deadline gate (github.ts:352) and forces one more full poll cycle —
      // issuing one more ghTransportMock call and 5 more gh calls for
      // other-sess, before the clean observation itself (unrelated to the fix)
      // finally drops the flag. The fix instead lets the deadline gate suppress
      // the tick immediately, so other-sess is never touched again.
      queuePollResponse("SUCCESS");
      const seededTransport = ghTransportMock.mock.calls.length;
      const seededGh = ghMock.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, REAL_INTERVAL_MS * 8));
      expect(ghTransportMock.mock.calls.length - seededTransport).toBe(0);
      expect(ghMock.mock.calls.length - seededGh).toBe(0);

      handle.stop();
    });

    it("does not advance the adaptive deadline for a poll cycle suppressed entirely by an active rate-limit cooldown", async () => {
      // Baseline: startup poll succeeds, legitimately arming the deadline at
      // T0 + slowIntervalMs = 00:10:00.
      queuePollResponse("SUCCESS");
      const rateLimitError = Object.assign(new Error("GraphQL: API rate limit already exceeded"), {
        stderr: JSON.stringify({
          errors: [{ message: "API rate limit already exceeded" }],
          data: { rateLimit: { resetAt: "2026-07-30T00:03:00.000Z" } },
        }),
      });

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(ghMock).toHaveBeenCalledTimes(5);

      // Force the next real tick to attempt a poll mid-window via recent
      // session activity, and let that attempt hit the rate limit. This is
      // the cycle that FIRST enters cooldown: `skippedByCooldown` is false
      // when captured (no cooldown existed yet), so it legitimately re-arms
      // the deadline — unchanged here since Date hasn't moved.
      hasRecentSessionUserActionMock.mockReturnValue(true);
      ghMock.mockRejectedValueOnce(rateLimitError);
      await waitForGhCallCount(6);

      // Move Date forward, still inside the cooldown window (lifts at
      // 00:03:00). The forced tick still fires, but this time
      // `shouldSkipGitHubCalls()` is already true when the cycle captures
      // `skippedByCooldown`, so the whole cycle is suppressed before any gh
      // call is made.
      vi.setSystemTime(new Date("2026-07-30T00:02:00.000Z"));
      await new Promise((resolve) => setTimeout(resolve, REAL_INTERVAL_MS * 4));
      expect(ghMock).toHaveBeenCalledTimes(6);

      // Stop forcing attempts and let the cooldown lift. Land on a Date that
      // is past the ORIGINAL deadline (00:10:00) but well short of where a
      // buggy implementation would have pushed the deadline to from the
      // suppressed cycle above (00:02:00 + 600_000 = 00:12:00). Only the
      // correct "deadline never moved" behavior lets this real tick poll.
      hasRecentSessionUserActionMock.mockReturnValue(false);
      vi.setSystemTime(new Date("2026-07-30T00:10:01.000Z"));
      queuePollResponse("SUCCESS");
      await waitForGhCallCount(11);

      handle.stop();
    });

    it("does not force an adaptive tick for a permanently disabled session", async () => {
      // Overridden entirely: bypasses legacyGhAdapter/ghMock, so only
      // waitForTransportCallCount (not waitForGhCallCount) can observe progress.
      ghTransportMock.mockResolvedValue(notFoundEnvelope(42, { withPath: true }));

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: {
          type: "github",
          intervalMs: REAL_INTERVAL_MS,
          runOnStart: false,
          emitExisting: false,
          adaptivePoll: { slowIntervalMs: 600_000, activeGraceMs: 600_000 },
        },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      // start()'s own ungated poll (runOnStart: false) seeds the permanent map.
      await waitForTransportCallCount(1);
      const seeded = listSessionsMock.mock.calls.length;

      // Recent session activity would otherwise force every real tick (the last
      // `hasRecentSessionUserAction` branch in shouldPollThisTick) regardless of
      // whether this session has already been attempted. With the
      // shouldPollThisTick gate in place, the permanently-disabled session hits its
      // own `continue` before that branch is ever reached, so each real tick makes
      // only the ONE listPollableSessions call inside shouldPollThisTick itself and
      // never invokes pollCycle. Without the gate, the activity check would force
      // pollCycle every tick, adding a SECOND listPollableSessions call from inside
      // pollSignals (github.ts:381) — listSessions is the only observable here: an
      // ungated tick still builds an empty batch and issues zero gh calls either way.
      hasRecentSessionUserActionMock.mockReturnValue(true);
      await new Promise((resolve) => setTimeout(resolve, REAL_INTERVAL_MS * 8));

      expect(listSessionsMock.mock.calls.length - seeded).toBeLessThanOrEqual(12);
      expect(ghTransportMock).toHaveBeenCalledTimes(1);

      handle.stop();
    });
  });

  describe("permanent PR not found", () => {
    function disabledEvents(): { event: string }[] {
      return logSpurEventMock.mock.calls
        .map(([, entry]) => entry as { event?: string })
        .filter((entry): entry is { event: string } => entry.event === "source.poll.disabled");
    }

    function errorEvents(): { event: string; sessionId?: string }[] {
      return logSpurEventMock.mock.calls
        .map(([, entry]) => entry as { event?: string; sessionId?: string })
        .filter(
          (entry): entry is { event: string; sessionId?: string } =>
            entry.event === "source.poll.error",
        );
    }

    it("stops polling a session whose bound PR does not exist after one source.poll.disabled", async () => {
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      ghTransportMock.mockResolvedValue(notFoundEnvelope(42, { withPath: true }));

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();
      handle.runOnStart?.();
      await flushPollCycle();
      handle.runOnStart?.();
      await flushPollCycle();

      expect(disabledEvents()).toHaveLength(1);
      expect(disabledEvents()[0]).toEqual(
        expect.objectContaining({
          event: "source.poll.disabled",
          level: "error",
          projectId: "api",
          sourceId: "pr-watch",
          sessionId: "api-a1b2",
          details: { prNumber: 42 },
        }),
      );
      expect(errorEvents()).toHaveLength(0);
      expect(ghTransportMock).toHaveBeenCalledTimes(1);

      handle.stop();
    });

    it("keeps polling a co-batched session when the joined GraphQL error names another PR", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      const otherSession = makeSession({
        id: "api-c3d4",
        workspaceId: "api-c3d4",
        pr: { number: 43, repo: "acme/api", url: "https://github.com/acme/api/pull/43" },
      });
      listSessionsMock.mockReturnValue([makeSession(), otherSession]);
      // No `path`: forces the joined-message fallback onto every alias in the batch.
      ghTransportMock.mockResolvedValueOnce(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
            r: { a0: null, a1: null },
          },
          errors: [
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a PullRequest with the number of 43.",
            },
          ],
        }),
      );

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();

      expect(disabledEvents()).toHaveLength(1);
      expect(disabledEvents()[0]).toEqual(
        expect.objectContaining({ sessionId: "api-c3d4", details: { prNumber: 43 } }),
      );
      expect(errorEvents().some((entry) => entry.sessionId === "api-a1b2")).toBe(true);
      expect(ghTransportMock).toHaveBeenCalledTimes(1);

      // Without advancing past api-a1b2's own transient backoff (armed by the same
      // poisoned cycle), the next cycle would find it gated too and issue zero gh
      // calls — the assertion below would be wrong, not the code.
      vi.setSystemTime(new Date(Date.now() + 120_001));
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      // The "Once" not-found mock above is consumed, so this reverts to the base
      // legacyGhAdapter implementation set in the outer beforeEach.
      mockLifecyclePoll(prView());
      listSessionsMock.mockReturnValue([makeSession()]);
      handle.runOnStart?.();
      await flushPollCycle();

      expect(ghTransportMock).toHaveBeenCalledTimes(2);
      expect(writeReviewSourceSnapshotMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        "github",
        "api",
        "pr-watch",
        "api-a1b2",
        expect.anything(),
      );

      handle.stop();
    });

    it("does not disable a session when the joined error names two PR numbers", async () => {
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      ghTransportMock.mockResolvedValue(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
            r: { a0: null },
          },
          errors: [
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a PullRequest with the number of 42.",
            },
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a PullRequest with the number of 43.",
            },
          ],
        }),
      );

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: false, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      expect(disabledEvents()).toHaveLength(0);
      expect(errorEvents().filter((entry) => entry.sessionId === "api-a1b2")).toHaveLength(1);

      handle.stop();
    });

    it("backs off a transient poll failure instead of retrying every cycle", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      ghTransportMock.mockRejectedValue(new Error("gh offline"));

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(1);
      expect(errorEvents()).toHaveLength(1);

      // Two more cycles with Date frozen: still gated, no new attempt.
      handle.runOnStart?.();
      await flushPollCycle();
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(1);
      expect(errorEvents()).toHaveLength(1);

      // Past the 120_000ms base delay: retries, doubling failures to 2.
      vi.setSystemTime(new Date(Date.now() + 120_001));
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(2);
      expect(errorEvents()).toHaveLength(2);

      // Frozen again: still gated.
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(2);

      // Only 120_000ms past the SECOND failure (window doubled to 240_000): still gated.
      vi.setSystemTime(new Date(Date.now() + 120_001));
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(2);

      // Past the full 240_000ms doubled window from the second failure: retries again.
      vi.setSystemTime(new Date(Date.now() + 240_001));
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(3);
      expect(errorEvents()).toHaveLength(3);

      handle.stop();
    });

    it("clears the transient backoff after a clean poll so the next failure restarts at the base delay", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      ghTransportMock.mockRejectedValueOnce(new Error("gh offline"));

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(1);

      // Frozen Date: the failure just recorded still gates the very next cycle.
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(1);

      // Past the base delay: a healthy poll clears the backoff entirely. The
      // preceding "Once" rejection is consumed, so this reverts to legacyGhAdapter.
      vi.setSystemTime(new Date(Date.now() + 120_001));
      mockLifecyclePoll(prView());
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(2);

      // The next failure restarts at the base delay, not the doubled one: a mere
      // 120_001ms advance (not 240_001) is enough for the following retry to fire.
      ghTransportMock.mockRejectedValueOnce(new Error("gh offline again"));
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(3);

      vi.setSystemTime(new Date(Date.now() + 120_001));
      ghTransportMock.mockRejectedValueOnce(new Error("still offline"));
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(4);

      expect(disabledEvents()).toHaveLength(0);

      handle.stop();
    });

    it("re-polls a session after it rebinds to a different PR number", async () => {
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      ghTransportMock.mockResolvedValueOnce(notFoundEnvelope(42, { withPath: true }));

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(1);
      expect(disabledEvents()).toHaveLength(1);

      listSessionsMock.mockReturnValue([
        makeSession({
          pr: { number: 43, repo: "acme/api", url: "https://github.com/acme/api/pull/43" },
        }),
      ]);
      // The "Once" not-found mock above is consumed, so this reverts to legacyGhAdapter.
      mockLifecyclePoll(prView({ number: 43, url: "https://github.com/acme/api/pull/43" }));
      handle.runOnStart?.();
      await flushPollCycle();

      expect(ghTransportMock).toHaveBeenCalledTimes(2);
      expect(disabledEvents()).toHaveLength(1);

      handle.stop();
    });

    it("never disables an unbound session on a not-found error", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeUnboundSession()]);
      ghTransportMock.mockResolvedValue(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
            r: { a0: { nodes: [] } },
          },
          errors: [
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a PullRequest with the number of 42.",
            },
          ],
        }),
      );

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();
      expect(disabledEvents()).toHaveLength(0);
      expect(errorEvents()).toHaveLength(1);
      expect(ghTransportMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(Date.now() + 120_001));
      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(2);

      handle.stop();
    });

    it("drops permanent and backoff state when the session disappears", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      ghTransportMock.mockResolvedValueOnce(notFoundEnvelope(42, { withPath: true }));

      const handle = await githubSourceModule.start({
        sourceId: "pr-watch",
        projectId: "api",
        dataDir: "/tmp/spur-data",
        config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      });

      handle.runOnStart?.();
      await flushPollCycle();
      expect(ghTransportMock).toHaveBeenCalledTimes(1);
      expect(disabledEvents()).toHaveLength(1);

      // Session disappears: the sweep at the end of the cycle drops its permanent
      // entry (github.ts's currentSessionIds sweep).
      listSessionsMock.mockReturnValue([]);
      handle.runOnStart?.();
      await flushPollCycle();

      // Session reappears (same id, still bound to PR 42), healthy this time. Date is
      // left frozen, so nothing here can be explained by a backoff/gate expiry — only
      // the sweep having cleared the permanent entry lets this poll happen at all.
      readReviewSourceSnapshotsMock.mockReturnValue(new Map());
      listSessionsMock.mockReturnValue([makeSession()]);
      // The "Once" not-found mock above is consumed, so this reverts to legacyGhAdapter.
      mockLifecyclePoll(prView());
      handle.runOnStart?.();
      await flushPollCycle();

      expect(ghTransportMock).toHaveBeenCalledTimes(2);
      expect(writeReviewSourceSnapshotMock).toHaveBeenCalledWith(
        "/tmp/spur-data",
        "github",
        "api",
        "pr-watch",
        "api-a1b2",
        expect.anything(),
      );
      expect(disabledEvents()).toHaveLength(1);

      handle.stop();
    });
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
