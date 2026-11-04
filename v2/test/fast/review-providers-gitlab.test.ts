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
    workspaceId: "api-a1",
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
    const mr = {
      iid: 9,
      title: "feat: x",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
      has_conflicts: true,
      detailed_merge_status: "broken",
      blocking_discussions_resolved: true,
    };
    glabMock.mockImplementation(async (_cwd: string, ...args: unknown[]) => {
      const endpoint = String(args[1] ?? "");
      if (endpoint.includes("/merge_requests?source_branch=")) return JSON.stringify([mr]);
      if (endpoint.includes("/pipelines")) {
        return JSON.stringify([
          { id: 100, status: "failed" },
          { id: 101, status: "success" },
        ]);
      }
      if (endpoint.includes("/discussions")) return "[]";
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await gitlabReviewProvider.collectSignals(
      makeSession(),
      "/tmp/data",
      "proj",
      "src",
    );

    const keys = Array.from(result?.snapshot.keys() ?? []);
    expect(keys).toContain("merge_conflict");
    expect(keys).toContain("ci_failed");
  });

  it("adds discussion targets only for non-individual notes", async () => {
    const mr = {
      iid: 9,
      title: "feat: x",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
      has_conflicts: false,
      detailed_merge_status: "mergeable",
      blocking_discussions_resolved: true,
    };
    glabMock.mockImplementation(async (_cwd: string, ...args: unknown[]) => {
      const endpoint = String(args[1] ?? "");
      if (endpoint.includes("/merge_requests?source_branch=")) return JSON.stringify([mr]);
      if (endpoint.includes("/pipelines")) return "[]";
      if (endpoint.includes("/discussions")) {
        return JSON.stringify([
          {
            id: "disc-1",
            individual_note: false,
            notes: [
              {
                id: 100,
                body: "threaded",
                author: { username: "reviewer" },
                position: { new_path: "src/api.ts", new_line: 7 },
              },
            ],
          },
          {
            id: "note-1",
            individual_note: true,
            notes: [{ id: 101, body: "standalone", author: { username: "reviewer" } }],
          },
        ]);
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await gitlabReviewProvider.collectSignals(
      makeSession(),
      "/tmp/data",
      "proj",
      "src",
    );

    expect(result?.snapshot.get("discussion:disc-1:100")).toEqual(
      expect.objectContaining({
        providerThreadTarget: {
          kind: "gitlab-discussion",
          mergeRequestIid: 9,
          discussionId: "disc-1",
        },
      }),
    );
    expect(result?.snapshot.get("comment:101")).not.toHaveProperty("providerThreadTarget");
  });

  it("annotates change keys and revisions from sha, base sha, pipelines and notes", async () => {
    const mr = {
      iid: 9,
      title: "feat: x",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
      has_conflicts: true,
      detailed_merge_status: "broken",
      blocking_discussions_resolved: true,
      sha: "head-sha",
      target_branch: "main",
      diff_refs: { base_sha: "merge-base-sha" },
    };
    glabMock.mockImplementation(async (_cwd: string, ...args: unknown[]) => {
      const endpoint = String(args[1] ?? "");
      if (endpoint.includes("/merge_requests?source_branch=")) return JSON.stringify([mr]);
      if (endpoint === "projects/group%2Fapp/repository/branches/main") {
        return JSON.stringify({ commit: { id: "base-sha" } });
      }
      if (endpoint.includes("/pipelines")) {
        return JSON.stringify([
          { id: 100, status: "failed" },
          { id: 101, status: "success" },
        ]);
      }
      if (endpoint.includes("/discussions")) {
        return JSON.stringify([
          {
            id: "disc-1",
            individual_note: false,
            notes: [
              { id: 100, body: "a", resolvable: true, resolved: false },
              { id: 105, body: "b", resolvable: true, resolved: false },
            ],
          },
          { id: "n1", individual_note: true, notes: [{ id: 120, body: "standalone" }] },
        ]);
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await gitlabReviewProvider.collectSignals(
      makeSession(),
      "/tmp/data",
      "proj",
      "src",
    );

    expect(result?.snapshot.get("ci_failed")).toMatchObject({
      changeKey: "head-sha",
      revision: "head-sha:100",
    });
    expect(result?.snapshot.get("merge_conflict")).toMatchObject({
      changeKey: "head-sha:base-sha",
      revision: "head-sha:base-sha",
    });
    expect(result?.snapshot.get("discussion:disc-1:100")?.changeKey).toBe("105:false");
    expect(result?.snapshot.get("comment:120")?.changeKey).toBe("120");
  });

  it("omits change keys when the merge request carries no sha", async () => {
    const mr = {
      iid: 9,
      title: "feat: x",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
      has_conflicts: true,
      detailed_merge_status: "broken",
    };
    glabMock.mockImplementation(async (_cwd: string, ...args: unknown[]) => {
      const endpoint = String(args[1] ?? "");
      if (endpoint.includes("/merge_requests?source_branch=")) return JSON.stringify([mr]);
      return "[]";
    });
    const result = await gitlabReviewProvider.collectSignals(
      makeSession(),
      "/tmp/data",
      "proj",
      "src",
    );
    expect(result?.snapshot.get("merge_conflict")).not.toHaveProperty("changeKey");
  });

  function mockConflictPoll(hasConflicts: boolean, targetTip: () => string): string[] {
    const endpoints: string[] = [];
    const mr = {
      iid: 9,
      title: "feat: x",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
      has_conflicts: hasConflicts,
      sha: "head-sha",
      target_branch: "main",
      diff_refs: { base_sha: "merge-base-sha" },
    };
    glabMock.mockImplementation(async (_cwd: string, ...args: unknown[]) => {
      const endpoint = String(args[1] ?? "");
      endpoints.push(endpoint);
      if (endpoint.includes("/merge_requests?source_branch=")) return JSON.stringify([mr]);
      if (endpoint.includes("/repository/branches/")) {
        return JSON.stringify({ commit: { id: targetTip() } });
      }
      return "[]";
    });
    return endpoints;
  }

  it("rekeys merge_conflict on a target-only push and keeps the key for the same pair", async () => {
    let tip = "tip-1";
    mockConflictPoll(true, () => tip);
    const poll = async () =>
      (
        await gitlabReviewProvider.collectSignals(makeSession(), "/tmp/data", "proj", "src")
      )?.snapshot.get("merge_conflict")?.changeKey;

    const first = await poll();
    const repeat = await poll();
    tip = "tip-2";
    const afterPush = await poll();

    expect(first).toBe("head-sha:tip-1");
    expect(repeat).toBe(first);
    expect(afterPush).toBe("head-sha:tip-2");
  });

  it("skips the branch lookup for a non-conflicting merge request", async () => {
    const endpoints = mockConflictPoll(false, () => "tip-1");
    const result = await gitlabReviewProvider.collectSignals(
      makeSession(),
      "/tmp/data",
      "proj",
      "src",
    );
    expect(result?.snapshot.has("merge_conflict")).toBe(false);
    expect(endpoints.some((endpoint) => endpoint.includes("/repository/branches/"))).toBe(false);
  });

  function mockBrokenBranchLookup(branchResponse: () => Promise<string>): void {
    const mr = {
      iid: 9,
      title: "feat: x",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
      has_conflicts: true,
      sha: "head-sha",
      target_branch: "main",
      diff_refs: { base_sha: "merge-base-sha" },
    };
    glabMock.mockImplementation(async (_cwd: string, ...args: unknown[]) => {
      const endpoint = String(args[1] ?? "");
      if (endpoint.includes("/merge_requests?source_branch=")) return JSON.stringify([mr]);
      if (endpoint.includes("/repository/branches/")) return branchResponse();
      if (endpoint.includes("/pipelines")) return JSON.stringify([{ id: 4, status: "failed" }]);
      return "[]";
    });
  }

  it.each([
    ["rejects", () => Promise.reject(new Error("glab api 404"))],
    ["returns malformed JSON", () => Promise.resolve("{not json")],
  ])(
    "keeps CI signals and a stable fallback conflict key when the branch lookup %s",
    async (_label, branchResponse) => {
      mockBrokenBranchLookup(branchResponse);
      const poll = () =>
        gitlabReviewProvider.collectSignals(makeSession(), "/tmp/data", "proj", "src");

      const first = await poll();
      const second = await poll();

      expect(first?.snapshot.get("ci_failed")).toMatchObject({ kind: "ci_failed" });
      expect(first?.snapshot.get("merge_conflict")).toMatchObject({
        changeKey: "head-sha:merge-base-sha",
        revision: "head-sha:merge-base-sha",
      });
      expect(second?.snapshot.get("merge_conflict")?.changeKey).toBe("head-sha:merge-base-sha");
      expect(second?.snapshot.get("merge_conflict")?.revision).toBe(
        first?.snapshot.get("merge_conflict")?.revision,
      );
      expect(first?.conflictBaseUnknown).toBe(true);
    },
  );
});
