import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubCheck, GitHubPrSummary } from "../../src/event-sources/github.js";

const ghMock = vi.fn();
const readCurrentBranchMock = vi.fn();
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
  resolvePrSummary,
  resolveTrackedBranch,
} = await import("../../src/event-sources/github.js");

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
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "STALE",
    ];
    for (const state of states) {
      const result = summarizeFailingCi([{ name: "check", state }]);
      expect(result).toContain("check");
    }
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

describe("resolvePrSummary", () => {
  beforeEach(() => {
    ghMock.mockReset();
  });
  afterEach(() => {
    ghMock.mockReset();
    readCurrentBranchMock.mockReset();
  });

  const listPr = {
    number: 212,
    title: "t",
    url: "https://github.com/o/r/pull/212",
    reviewDecision: "REVIEW_REQUIRED",
  };

  it("forces compute via pr view when pr list returns UNKNOWN mergeability", async () => {
    ghMock
      .mockResolvedValueOnce(
        JSON.stringify([{ ...listPr, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      );

    const pr = await resolvePrSummary("/wt", "feature/x");
    expect(pr?.mergeable).toBe("CONFLICTING");
    expect(pr?.mergeStateStatus).toBe("DIRTY");
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(ghMock.mock.calls[1]).toEqual([
      "/wt",
      "pr",
      "view",
      "212",
      "--json",
      "mergeable,mergeStateStatus",
    ]);
  });

  it("skips pr view when pr list already returns a resolved mergeability", async () => {
    ghMock.mockResolvedValueOnce(
      JSON.stringify([{ ...listPr, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }]),
    );

    const pr = await resolvePrSummary("/wt", "feature/x");
    expect(pr?.mergeable).toBe("MERGEABLE");
    expect(pr?.mergeStateStatus).toBe("BLOCKED");
    expect(ghMock).toHaveBeenCalledTimes(1);
  });

  it("keeps UNKNOWN when the pr view fallback fails", async () => {
    ghMock
      .mockResolvedValueOnce(
        JSON.stringify([{ ...listPr, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }]),
      )
      .mockRejectedValueOnce(new Error("gh offline"));

    const pr = await resolvePrSummary("/wt", "feature/x");
    expect(pr?.mergeable).toBe("UNKNOWN");
    expect(pr?.mergeStateStatus).toBe("UNKNOWN");
  });

  it("returns null when no PR matches the branch", async () => {
    ghMock.mockResolvedValueOnce("[]");
    const pr = await resolvePrSummary("/wt", "feature/x");
    expect(pr).toBeNull();
    expect(ghMock).toHaveBeenCalledTimes(1);
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
