import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const glabMock = vi.fn();

vi.mock("../../src/glab.js", () => ({
  glab: (...args: unknown[]) => glabMock(...args),
}));

import {
  gitlabReviewProvider,
  resolveMergeRequestSummary,
} from "../../src/review-providers/gitlab.js";
import type { SessionRecord } from "../../src/types.js";

function makeSession(): SessionRecord {
  return {
    id: "api-a1",
    project: "api",
    agent: "claude",
    prompt: "",
    branch: "feat/x",
    worktree: true,
    worktreePath: "/tmp/wt",
    tmuxSession: "api-a1",
    launchCommand: "",
    status: "running",
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  glabMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveMergeRequestSummary", () => {
  it("returns null when the merge-request list is empty", async () => {
    glabMock.mockResolvedValueOnce("[]");
    const result = await resolveMergeRequestSummary("/tmp/wt", "feat/x");
    expect(result).toBeNull();
  });

  it("maps merge-request fields and derives the project path from the URL", async () => {
    glabMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          iid: 7,
          title: "feat: thing",
          web_url: "https://gitlab.example.com/group/app/-/merge_requests/7",
          has_conflicts: true,
          detailed_merge_status: "broken_status",
          blocking_discussions_resolved: true,
        },
      ]),
    );

    const summary = await resolveMergeRequestSummary("/tmp/wt", "feat/x");

    expect(summary).toEqual({
      number: 7,
      title: "feat: thing",
      url: "https://gitlab.example.com/group/app/-/merge_requests/7",
      reviewDecision: "none",
      repo: "group/app",
      mergeable: "CONFLICTING",
      mergeStateStatus: "broken_status",
    });
  });
});

describe("gitlabReviewProvider.findReviewUrlByBranch", () => {
  it("returns the merge request URL when present", async () => {
    glabMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          iid: 7,
          title: "feat: thing",
          web_url: "https://gitlab.example.com/group/app/-/merge_requests/7",
        },
      ]),
    );

    const url = await gitlabReviewProvider.findReviewUrlByBranch("/tmp/wt", "feat/x");
    expect(url).toBe("https://gitlab.example.com/group/app/-/merge_requests/7");
  });

  it("returns null when no merge request matches", async () => {
    glabMock.mockResolvedValueOnce("[]");
    expect(await gitlabReviewProvider.findReviewUrlByBranch("/tmp/wt", "feat/x")).toBeNull();
  });
});

describe("gitlabReviewProvider.collectSignals", () => {
  it("emits merge_conflict and ci_failed signals from failing pipelines", async () => {
    glabMock.mockImplementation(async (_cwd: string, ..._args: unknown[]) => {
      const endpoint = String(_args[1] ?? "");
      if (endpoint.includes("/merge_requests?source_branch=")) {
        return JSON.stringify([
          {
            iid: 9,
            title: "feat: x",
            web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
            has_conflicts: true,
            detailed_merge_status: "broken",
            blocking_discussions_resolved: true,
          },
        ]);
      }
      if (endpoint.includes("/pipelines")) {
        return JSON.stringify([
          { id: 100, status: "failed" },
          { id: 101, status: "success" },
        ]);
      }
      if (endpoint.includes("/discussions")) {
        return "[]";
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await gitlabReviewProvider.collectSignals(
      makeSession(),
      "/tmp/data",
      "proj",
      "src",
    );
    expect(result).not.toBeNull();
    const keys = Array.from(result?.snapshot.keys() ?? []);
    expect(keys).toContain("merge_conflict");
    expect(keys).toContain("ci_failed");
  });
});
