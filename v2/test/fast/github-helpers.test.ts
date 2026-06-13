import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubMergeConflictRestoreReplay,
  hasGitHubMergeConflictRestoreReplay,
  requestGitHubMergeConflictRestoreReplay,
  writeGitHubSourceSnapshot,
  writeSession,
} from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";
import type { GitHubCheck, GitHubPrSummary } from "../../src/event-sources/github.js";

const { ghMock, readCurrentBranchMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  readCurrentBranchMock: vi.fn(),
}));
vi.mock("../../src/gh.js", () => ({
  gh: ghMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: readCurrentBranchMock,
}));

const {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolveTrackedBranch,
  githubSourceModule,
} = await import("../../src/event-sources/github.js");

const { resolveBoundPrSummary } = await import("../../src/review-providers/github.js");

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
    const states = ["FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "CANCELED", "ACTION_REQUIRED"];
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
    ghMock
      .mockResolvedValueOnce(
        JSON.stringify({
          number: 42,
          title: "Keep branch mergeable",
          url: "https://github.com/acme/api/pull/42",
          reviewDecision: null,
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        }),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");

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
    ghMock
      .mockResolvedValueOnce(
        JSON.stringify({
          number: 42,
          title: "Keep branch mergeable",
          url: "https://github.com/acme/api/pull/42",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");

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
    ghMock
      .mockResolvedValueOnce(
        JSON.stringify({
          number: 42,
          title: "Keep branch mergeable",
          url: "https://github.com/acme/api/pull/42",
          reviewDecision: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
      )
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            id: 1001,
            body: "Please rerun the focused runtime test.",
            user: {
              login: "reviewer",
            },
          },
        ]),
      )
      .mockResolvedValueOnce("[]");

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
    writeGitHubSourceSnapshot(dataDir, "api", "pr-watch", "api-1", new Map());

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
