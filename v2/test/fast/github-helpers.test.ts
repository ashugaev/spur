import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ghModule from "../../src/gh.js";
import {
  clearGitHubMergeConflictRestoreReplay,
  hasGitHubMergeConflictRestoreReplay,
  readGitHubSourceSnapshot,
  requestGitHubMergeConflictRestoreReplay,
  writeGitHubSourceSnapshot,
  writeSession,
} from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";
import type { GitHubCheck, GitHubPrSummary } from "../../src/event-sources/github.js";

const { ghMock, readCurrentBranchMock, isGitWorktreeMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  readCurrentBranchMock: vi.fn(),
  isGitWorktreeMock: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: readCurrentBranchMock,
  readRemoteUrls: vi.fn().mockResolvedValue(new Map([["origin", "git@github.com:acme/api.git"]])),
  isGitWorktree: isGitWorktreeMock,
}));

const {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolvePrSummary,
  resolveTrackedBranch,
  githubSourceModule,
} = await import("../../src/event-sources/github.js");

const {
  _resetGitHubReviewBatchForTests,
  collectGitHubSignalsBatch,
  resolveBoundPrSummary,
  hasActiveChecks,
  githubReviewProvider,
} = await import("../../src/review-providers/github.js");
const { _resetPrLookupsForTests } = await import("../../src/pr-lookup.js");
const { _resetPrLookupCacheForTests, readPrLookupEntry } =
  await import("../../src/pr-lookup-cache.js");

function prSummary(overrides: Partial<GitHubPrSummary> = {}): GitHubPrSummary {
  return {
    number: 1,
    title: "test",
    url: "https://github.com/owner/repo/pull/1",
    reviewDecision: "none",
    repo: "owner/repo",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

function sourceSession(worktreePath: string): SessionRecord {
  return {
    id: "api-1",
    project: "api",
    workspaceId: "api-1",
    agent: "claude",
    prompt: "hello",
    branch: "feature/test",
    pr: {
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    },
    worktree: true,
    worktreePath,
    tmuxSession: "api-1",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
  };
}

function reviewBatchEnvelope(
  pr: Record<string, unknown>,
  issueComments: Array<Record<string, unknown>> = [],
): string {
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-03-18T11:00:00.000Z" },
      r: {
        a0: {
          ...pr,
          commits: { nodes: [] },
          reviewThreads: { nodes: [] },
          reviews: { nodes: [] },
          comments: {
            nodes: issueComments.map((comment) => ({
              ...comment,
              databaseId: comment.id,
              author: comment.user,
            })),
          },
        },
      },
    },
  });
}

describe("shortText", () => {
  it("returns unchanged text within limit", () => {
    expect(shortText("hello world")).toBe("hello world");
  });

  it("truncates text over the limit with ellipsis", () => {
    const long = "a".repeat(200);
    const result = shortText(long);
    expect(result.length).toBeLessThanOrEqual(140);
    expect(result.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(shortText("hello   \n\t  world")).toBe("hello world");
  });

  it("respects a custom limit", () => {
    const result = shortText("hello world", 6);
    expect(result).toBe("hello…");
  });

  it("returns empty string for empty input", () => {
    expect(shortText("")).toBe("");
  });
});

describe("parseRepoFromUrl", () => {
  it("extracts owner/repo from a GitHub PR URL", () => {
    expect(parseRepoFromUrl("https://github.com/acme/api/pull/42")).toBe("acme/api");
  });

  it("returns empty string for an issues URL", () => {
    expect(parseRepoFromUrl("https://github.com/acme/api/issues/5")).toBe("");
  });

  it("returns empty string for an invalid URL", () => {
    expect(parseRepoFromUrl("not-a-url")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(parseRepoFromUrl("")).toBe("");
  });
});

describe("normalizeReviewDecision", () => {
  it("maps APPROVED to approved", () => {
    expect(normalizeReviewDecision("APPROVED")).toBe("approved");
  });

  it("maps CHANGES_REQUESTED to changes_requested", () => {
    expect(normalizeReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
  });

  it("maps REVIEW_REQUIRED to pending", () => {
    expect(normalizeReviewDecision("REVIEW_REQUIRED")).toBe("pending");
  });

  it("maps null to none", () => {
    expect(normalizeReviewDecision(null)).toBe("none");
  });

  it("maps undefined to none", () => {
    expect(normalizeReviewDecision(undefined)).toBe("none");
  });

  it("maps empty string to none", () => {
    expect(normalizeReviewDecision("")).toBe("none");
  });

  it("maps unknown values to none", () => {
    expect(normalizeReviewDecision("DISMISSED")).toBe("none");
  });

  it("handles mixed case with whitespace", () => {
    expect(normalizeReviewDecision("  approved  ")).toBe("approved");
  });
});

describe("summarizeFailingCi", () => {
  it("returns null for empty checks", () => {
    expect(summarizeFailingCi([])).toBeNull();
  });

  it("returns null when all checks pass", () => {
    const checks: GitHubCheck[] = [
      { name: "build", state: "SUCCESS" },
      { name: "lint", state: "SUCCESS" },
    ];
    expect(summarizeFailingCi(checks)).toBeNull();
  });

  it("lists failing check names", () => {
    const checks: GitHubCheck[] = [
      { name: "build", state: "FAILURE" },
      { name: "lint", state: "SUCCESS" },
      { name: "deploy", state: "TIMED_OUT" },
    ];
    const result = summarizeFailingCi(checks);
    expect(result).toContain("build");
    expect(result).toContain("deploy");
    expect(result).not.toContain("lint");
  });

  it("recognizes all failing state values", () => {
    const states = [
      "FAILURE",
      "FAILED",
      "TIMED_OUT",
      "CANCELLED",
      "CANCELED",
      "ACTION_REQUIRED",
      "ERROR",
      "STARTUP_FAILURE",
    ];
    for (const state of states) {
      const result = summarizeFailingCi([{ name: "check", state }]);
      expect(result).toContain("check");
    }
  });

  it("ignores skipped, neutral, and stale GitHub checks", () => {
    const checks: GitHubCheck[] = [
      { name: "skipped", state: "SKIPPED" },
      { name: "neutral", state: "NEUTRAL" },
      { name: "stale", state: "STALE" },
    ];

    expect(summarizeFailingCi(checks)).toBeNull();
  });

  it("uses conclusion values when GitHub provides them", () => {
    const checks: GitHubCheck[] = [
      { name: "build", state: "COMPLETED", conclusion: "failure" },
      { name: "docs", state: "COMPLETED", conclusion: "skipped" },
    ];

    const result = summarizeFailingCi(checks);

    expect(result).toContain("build");
    expect(result).not.toContain("docs");
  });
});

describe("hasActiveChecks", () => {
  it("returns false for an empty checks array", () => {
    expect(hasActiveChecks([])).toBe(false);
  });

  it("returns false when every check is in a known-terminal state", () => {
    const checks: GitHubCheck[] = [
      { name: "build", state: "SUCCESS" },
      { name: "lint", state: "FAILURE" },
      { name: "docs", state: "SKIPPED" },
    ];
    expect(hasActiveChecks(checks)).toBe(false);
  });

  it("returns true for a check in an unrecognized, non-terminal-shaped state", () => {
    const checks: GitHubCheck[] = [{ name: "e2e", state: "IN_PROGRESS" }];
    expect(hasActiveChecks(checks)).toBe(true);
  });

  it("returns true when active and terminal checks are mixed", () => {
    const checks: GitHubCheck[] = [
      { name: "build", state: "SUCCESS" },
      { name: "e2e", state: "QUEUED" },
    ];
    expect(hasActiveChecks(checks)).toBe(true);
  });

  it("treats ERROR and STARTUP_FAILURE as terminal, not active, so a permanently failed check never pins CI-active hysteresis", () => {
    const checks: GitHubCheck[] = [
      { name: "legacy-status", state: "ERROR" },
      { name: "action-run", state: "STARTUP_FAILURE" },
    ];
    expect(hasActiveChecks(checks)).toBe(false);
  });
});

describe("hasMergeConflict", () => {
  it("returns true for CONFLICTING mergeable", () => {
    expect(hasMergeConflict(prSummary({ mergeable: "CONFLICTING" }))).toBe(true);
  });

  it("returns true for DIRTY mergeStateStatus", () => {
    expect(hasMergeConflict(prSummary({ mergeStateStatus: "DIRTY" }))).toBe(true);
  });

  it("returns false for clean PR", () => {
    expect(hasMergeConflict(prSummary())).toBe(false);
  });

  it("returns false for null-ish fields", () => {
    expect(hasMergeConflict(prSummary({ mergeable: "", mergeStateStatus: "" }))).toBe(false);
  });
});

describe("resolveBoundPrSummary", () => {
  beforeEach(() => {
    ghMock.mockReset();
  });
  afterEach(() => {
    ghMock.mockReset();
    readCurrentBranchMock.mockReset();
  });

  it("loads the tracked PR directly from the persisted binding", async () => {
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        number: 212,
        title: "native binding",
        url: "https://github.com/o/r/pull/212",
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: { state: "FAILURE" },
        state: "OPEN",
        isDraft: true,
      }),
    );

    const pr = await resolveBoundPrSummary("/wt", {
      number: 212,
      repo: "o/r",
      url: "https://github.com/o/r/pull/212",
    });

    expect(pr).toMatchObject({
      number: 212,
      title: "native binding",
      url: "https://github.com/o/r/pull/212",
      reviewDecision: "changes_requested",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      statusCheckRollupState: "FAILURE",
      draft: true,
      state: "OPEN",
    });
    expect(ghMock).toHaveBeenCalledWith(
      "/wt",
      "pr",
      "view",
      "212",
      "--json",
      "number,title,url,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,state,isDraft",
    );
  });

  it("falls back to the stored URL when gh omits url", async () => {
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        number: 212,
        title: "native binding",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    );

    const pr = await resolveBoundPrSummary("/wt", {
      number: 212,
      repo: "o/r",
      url: "https://github.com/o/r/pull/212",
    });

    expect(pr?.url).toBe("https://github.com/o/r/pull/212");
    expect(pr?.repo).toBe("o/r");
  });

  it("propagates the gh error when gh pr view fails", async () => {
    ghMock.mockRejectedValueOnce(new Error("gh offline"));

    await expect(
      resolveBoundPrSummary("/wt", {
        number: 212,
        repo: "o/r",
        url: "https://github.com/o/r/pull/212",
      }),
    ).rejects.toThrow("gh offline");
  });

  it("throws when gh returns an invalid PR summary", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify({ url: "https://github.com/o/r/pull/212" }));

    await expect(
      resolveBoundPrSummary("/wt", {
        number: 212,
        repo: "o/r",
        url: "https://github.com/o/r/pull/212",
      }),
    ).rejects.toThrow("invalid GitHub PR summary");
  });
});

describe("collectSignals GraphQL batch", () => {
  beforeEach(() => {
    ghMock.mockReset();
  });

  function graphqlResult(checks: unknown[]): string {
    return JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 4_900, resetAt: "2026-08-04T18:00:00.000Z" },
        r: {
          a0: {
            number: 42,
            title: "Fix CI alert",
            url: "https://github.com/acme/api/pull/42",
            reviewDecision: null,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            isDraft: false,
            state: "OPEN",
            commits: {
              nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }],
            },
            reviewThreads: { nodes: [] },
            reviews: { nodes: [] },
            comments: { nodes: [] },
          },
        },
      },
    });
  }

  it("reports no active CI for an empty check rollup", async () => {
    ghMock.mockResolvedValueOnce(graphqlResult([]));

    const result = await githubReviewProvider.collectSignals(
      sourceSession("/wt"),
      "/tmp/spur-data",
      "api",
      "pr-watch",
    );

    expect(result?.ciActive).toBe(false);
    expect(result?.ciCheckFetchFailed).toBe(false);
  });

  it("reports active CI from the batched rollup", async () => {
    ghMock.mockResolvedValueOnce(
      graphqlResult([{ name: "workflow", status: "IN_PROGRESS", conclusion: null }]),
    );

    const result = await githubReviewProvider.collectSignals(
      sourceSession("/wt"),
      "/tmp/spur-data",
      "api",
      "pr-watch",
    );

    expect(result?.ciActive).toBe(true);
    expect(result?.ciCheckFetchFailed).toBe(false);
  });
});

describe("resolvePrSummary", () => {
  beforeEach(() => {
    ghMock.mockReset();
  });
  afterEach(() => {
    ghMock.mockReset();
  });

  it("resolves the highest-numbered OPEN PR when the branch also has a closed one", async () => {
    // `gh pr list --head <branch> --state all` can return several PRs for one
    // branch (retried work); `prs[0]`'s ordering was never a documented gh
    // contract. The live PR must win over stale history regardless of order.
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 10,
          title: "old attempt",
          url: "https://github.com/o/r/pull/10",
          reviewDecision: null,
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          state: "CLOSED",
          isDraft: false,
        },
        {
          number: 21,
          title: "current attempt",
          url: "https://github.com/o/r/pull/21",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          state: "OPEN",
          isDraft: false,
        },
      ]),
    );

    const pr = await resolvePrSummary("/wt", "feature/retry");

    expect(pr?.number).toBe(21);
    expect(pr?.state).toBe("OPEN");
  });

  it("falls back to the highest-numbered PR overall when none is open", async () => {
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 10,
          title: "first attempt",
          url: "https://github.com/o/r/pull/10",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          state: "CLOSED",
          isDraft: false,
        },
        {
          number: 21,
          title: "second attempt",
          url: "https://github.com/o/r/pull/21",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          state: "MERGED",
          isDraft: false,
        },
      ]),
    );

    const pr = await resolvePrSummary("/wt", "feature/retry");

    expect(pr?.number).toBe(21);
    expect(pr?.state).toBe("MERGED");
  });
});

describe("resolveTrackedBranch", () => {
  beforeEach(() => {
    readCurrentBranchMock.mockReset();
  });

  it("prefers the current worktree branch over stale session metadata", async () => {
    readCurrentBranchMock.mockResolvedValueOnce("feature/live");

    await expect(resolveTrackedBranch("/wt", "stale-session-branch")).resolves.toBe("feature/live");
    expect(readCurrentBranchMock).toHaveBeenCalledWith("/wt");
  });

  it("falls back to the persisted session branch when git reports detached HEAD", async () => {
    readCurrentBranchMock.mockResolvedValueOnce("HEAD");

    await expect(resolveTrackedBranch("/wt", "feature/session")).resolves.toBe("feature/session");
  });

  it("falls back to the persisted session branch when the worktree lookup fails", async () => {
    readCurrentBranchMock.mockRejectedValueOnce(new Error("missing worktree"));

    await expect(resolveTrackedBranch("/wt", "feature/session")).resolves.toBe("feature/session");
  });
});

describe("GitHub review batching", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    ghMock.mockReset();
    _resetGitHubReviewBatchForTests();
    _resetPrLookupsForTests();
    _resetPrLookupCacheForTests();
  });

  afterEach(async () => {
    _resetGitHubReviewBatchForTests();
    _resetPrLookupsForTests();
    _resetPrLookupCacheForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-review-batch-"));
    tempDirs.push(dataDir);
    return dataDir;
  }

  function unboundSession(id: string): SessionRecord {
    const { pr: _pr, ...session } = sourceSession(`/tmp/${id}`);
    return { ...session, id, branch: "feature/no-pr" };
  }

  it("shares the persisted absent cache with branch attention lookups", async () => {
    const dataDir = await makeDataDir();
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_900, resetAt: "2026-08-04T18:00:00.000Z" },
          r: { a0: { nodes: [] } },
        },
      }),
    );
    const sessions = [unboundSession("api-1"), unboundSession("api-2")];

    await collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");
    const second = await collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect([...second.values()]).toEqual([
      { status: "skipped", reason: "cached" },
      { status: "skipped", reason: "cached" },
    ]);
    expect(
      readPrLookupEntry(
        dataDir,
        { host: "github.com", owner: "acme", name: "api" },
        "feature/no-pr",
      )?.misses,
    ).toBe(1);
  });

  it("parks an unbound terminal PR in the shared cache", async () => {
    const dataDir = await makeDataDir();
    const terminal = {
      number: 41,
      title: "Merged work",
      url: "https://github.com/acme/api/pull/41",
      reviewDecision: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      isDraft: false,
      state: "MERGED",
      commits: { nodes: [] },
      reviewThreads: { nodes: [] },
      reviews: { nodes: [] },
      comments: { nodes: [] },
    };
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_900, resetAt: "2026-08-04T18:00:00.000Z" },
          r: { a0: { nodes: [terminal] } },
        },
      }),
    );
    const session = unboundSession("api-1");

    await collectGitHubSignalsBatch([session], dataDir, "api", "pr-watch");
    const second = await collectGitHubSignalsBatch([session], dataDir, "api", "pr-watch");

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(second.get("api-1")).toEqual({ status: "skipped", reason: "cached" });
    expect(
      readPrLookupEntry(
        dataDir,
        { host: "github.com", owner: "acme", name: "api" },
        "feature/no-pr",
      )?.terminal,
    ).toEqual({ number: 41, state: "MERGED" });
  });

  it("limits each repo cycle to 50 targets and rotates the remainder", async () => {
    const dataDir = await makeDataDir();
    const sessions = Array.from({ length: 51 }, (_unused, index) => ({
      ...sourceSession(`/tmp/api-${index}`),
      id: `api-${index}`,
      pr: {
        number: index + 1,
        repo: "acme/api",
        url: `https://github.com/acme/api/pull/${index + 1}`,
      },
    }));
    ghMock.mockImplementation((_cwd: string, ...args: string[]) => {
      const numbers = args
        .filter((arg) => /^n\d+=/.test(arg))
        .map((arg) => Number(arg.slice(arg.indexOf("=") + 1)));
      const aliases = Object.fromEntries(
        numbers.map((number, index) => [
          `a${index}`,
          {
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
          },
        ]),
      );
      return Promise.resolve(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 4_900, resetAt: "2026-08-04T18:00:00.000Z" },
            r: aliases,
          },
        }),
      );
    });

    const first = await collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");
    const second = await collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");

    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(ghMock.mock.calls[0]?.join(" ").match(/n\d+=/g)).toHaveLength(50);
    expect(first.get("api-50")).toEqual({ status: "skipped", reason: "capacity" });
    expect(second.get("api-50")?.status).toBe("ok");
  });

  it("requests the newest 100 signals and surfaces the newest item", async () => {
    const dataDir = await makeDataDir();
    const comments = Array.from({ length: 100 }, (_unused, index) => ({
      id: index + 2,
      body: `comment ${index + 2}`,
      author: { login: "reviewer" },
    }));
    ghMock.mockResolvedValueOnce(
      reviewBatchEnvelope(
        {
          number: 42,
          title: "Newest feedback",
          url: "https://github.com/acme/api/pull/42",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          isDraft: false,
          state: "OPEN",
        },
        comments,
      ),
    );

    const result = await collectGitHubSignalsBatch(
      [sourceSession("/tmp/api-1")],
      dataDir,
      "api",
      "pr-watch",
    );

    const call = ghMock.mock.calls[0]?.join(" ") ?? "";
    expect(call).toContain("comments(last:100)");
    expect(call).toContain("reviewThreads(last:20)");
    const collected = result.get("api-1");
    expect(collected?.status).toBe("ok");
    if (collected?.status !== "ok" || !collected.collected) throw new Error("missing result");
    expect(collected.collected.snapshot.has("comment:101")).toBe(true);
    expect(collected.collected.snapshot.has("comment:1")).toBe(false);
  });

  it("surfaces every new same-thread comment returned between polls", async () => {
    const dataDir = await makeDataDir();
    ghMock.mockResolvedValueOnce(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-03-18T11:00:00.000Z" },
          r: {
            a0: {
              number: 42,
              title: "Thread feedback",
              url: "https://github.com/acme/api/pull/42",
              reviewDecision: null,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              isDraft: false,
              state: "OPEN",
              commits: { nodes: [] },
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    comments: {
                      nodes: [101, 102, 103].map((databaseId) => ({
                        databaseId,
                        body: `feedback ${databaseId}`,
                        path: "src/api.ts",
                        line: databaseId,
                        author: { login: "reviewer" },
                      })),
                    },
                  },
                ],
              },
              reviews: { nodes: [] },
              comments: { nodes: [] },
            },
          },
        },
      }),
    );

    const result = await collectGitHubSignalsBatch(
      [sourceSession("/tmp/api-1")],
      dataDir,
      "api",
      "pr-watch",
    );

    expect(ghMock.mock.calls[0]?.join(" ")).toContain("comments(last:100)");
    const collected = result.get("api-1");
    expect(collected?.status).toBe("ok");
    if (collected?.status !== "ok" || !collected.collected) throw new Error("missing result");
    expect([...collected.collected.snapshot.keys()]).toEqual(
      expect.arrayContaining(["review-comment:101", "review-comment:102", "review-comment:103"]),
    );
  });
});

describe("github source rearm", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    ghMock.mockReset();
    readCurrentBranchMock.mockReset().mockResolvedValue("feature/test");
  });

  afterEach(async () => {
    vi.useRealTimers();
    ghMock.mockReset();
    readCurrentBranchMock.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createRuntimeState(): Promise<{ dataDir: string; worktreePath: string }> {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-gh-source-"));
    const worktreePath = join(dataDir, "worktree");
    await mkdir(worktreePath, { recursive: true });
    tempDirs.push(dataDir);
    return { dataDir, worktreePath };
  }

  it("re-delivers active signals on rearm and clears the marker", async () => {
    const { dataDir, worktreePath } = await createRuntimeState();
    writeSession(dataDir, sourceSession(worktreePath));
    requestGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1");
    ghMock.mockResolvedValueOnce(
      reviewBatchEnvelope({
        number: 42,
        title: "Keep branch mergeable",
        url: "https://github.com/acme/api/pull/42",
        reviewDecision: null,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        state: "OPEN",
        isDraft: false,
      }),
    );

    const events: Array<{ name: string; data?: unknown }> = [];
    const controller = new AbortController();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir,
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
      },
      emit(name, data) {
        events.push({ name, data });
      },
      signal: controller.signal,
      logger: {},
    });

    try {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "github:merge_conflict",
        data: {
          sessionId: "api-1",
          prNumber: 42,
        },
      });
      expect(hasGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1")).toBe(false);
    } finally {
      controller.abort();
      handle.stop();
    }
  });

  it("keeps quiet and clears the marker when rearm finds no active signals", async () => {
    const { dataDir, worktreePath } = await createRuntimeState();
    writeSession(dataDir, sourceSession(worktreePath));
    requestGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1");
    ghMock.mockResolvedValueOnce(
      reviewBatchEnvelope({
        number: 42,
        title: "Keep branch mergeable",
        url: "https://github.com/acme/api/pull/42",
        reviewDecision: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        state: "OPEN",
        isDraft: false,
      }),
    );

    const events: Array<{ name: string; data?: unknown }> = [];
    const controller = new AbortController();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir,
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
      },
      emit(name, data) {
        events.push({ name, data });
      },
      signal: controller.signal,
      logger: {},
    });

    try {
      expect(events).toEqual([]);
      expect(hasGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1")).toBe(false);
    } finally {
      controller.abort();
      handle.stop();
    }
  });

  it("does not replay non-conflict GitHub signals during restore replay", async () => {
    const { dataDir, worktreePath } = await createRuntimeState();
    writeSession(dataDir, sourceSession(worktreePath));
    requestGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1");
    ghMock.mockResolvedValueOnce(
      reviewBatchEnvelope(
        {
          number: 42,
          title: "Keep branch mergeable",
          url: "https://github.com/acme/api/pull/42",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          state: "OPEN",
          isDraft: false,
        },
        [
          {
            id: 1001,
            body: "Please rerun the focused runtime test.",
            user: {
              login: "reviewer",
            },
          },
        ],
      ),
    );

    const events: Array<{ name: string; data?: unknown }> = [];
    const controller = new AbortController();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir,
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
      },
      emit(name, data) {
        events.push({ name, data });
      },
      signal: controller.signal,
      logger: {},
    });

    try {
      expect(events).toEqual([]);
      expect(hasGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1")).toBe(false);
    } finally {
      controller.abort();
      handle.stop();
    }
  });

  it("clears stale rearm markers when the session disappears", async () => {
    const { dataDir } = await createRuntimeState();
    requestGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1");
    writeGitHubSourceSnapshot(dataDir, "api", "pr-watch", "api-1", {
      prNumber: 42,
      signals: new Map(),
    });

    const controller = new AbortController();
    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir,
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        emitExisting: false,
      },
      emit() {},
      signal: controller.signal,
      logger: {},
    });

    try {
      expect(hasGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1")).toBe(false);
    } finally {
      controller.abort();
      handle.stop();
      clearGitHubMergeConflictRestoreReplay(dataDir, "api", "pr-watch", "api-1");
    }
  });
});

describe("review snapshot envelope", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-gh-snapshot-"));
    tempDirs.push(dataDir);
    return dataDir;
  }

  it("round-trips prNumber and signal keys through the real writer and reader", async () => {
    const dataDir = await createDataDir();
    const signal = { key: "ci_failed", kind: "ci_failed" as const, text: "CI is failing: build." };
    writeGitHubSourceSnapshot(dataDir, "api", "pr-watch", "api-1", {
      prNumber: 42,
      signals: new Map([[signal.key, signal]]),
    });

    const stored = readGitHubSourceSnapshot(dataDir, "api", "pr-watch", "api-1");

    expect(stored?.prNumber).toBe(42);
    expect(stored?.signals.get("ci_failed")).toEqual(signal);
  });

  it("parses a hand-written legacy bare-array snapshot to prNumber: null", async () => {
    // Legacy on-disk shape predates the envelope: a bare `ReviewSignal[]`, no
    // `prNumber` field. `Array.isArray` is the sole discriminator (no `version`
    // field — nothing would ever read one), and the legacy default is `null`.
    const dataDir = await createDataDir();
    const dir = join(dataDir, "source-state", "github", "api", "pr-watch");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "api-1.json"),
      JSON.stringify([
        { key: "closed", kind: "closed", text: "PR #42 was closed without merging." },
      ]),
      "utf-8",
    );

    const stored = readGitHubSourceSnapshot(dataDir, "api", "pr-watch", "api-1");

    expect(stored?.prNumber).toBeNull();
    expect(stored?.signals.get("closed")).toEqual({
      key: "closed",
      kind: "closed",
      text: "PR #42 was closed without merging.",
    });
  });
});
