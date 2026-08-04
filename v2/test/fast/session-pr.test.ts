import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ghModule from "../../src/gh.js";
import type { SessionRecord } from "../../src/types.js";

const { ghMock, readCurrentBranchMock, readRemoteUrlsMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  readCurrentBranchMock: vi.fn(),
  readRemoteUrlsMock: vi.fn(),
}));

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: readCurrentBranchMock,
  readRemoteUrls: readRemoteUrlsMock,
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: vi.fn(),
}));

const {
  closeSessionPr,
  deriveSessionSlots,
  listOpenPullRequests,
  discoverSessionPrBinding,
  normalizeSessionPrBinding,
  parseSessionPrBinding,
  resolveRepoSlug,
  viewSessionPrState,
} = await import("../../src/session-pr.js");
const { _resetPrLookupsForTests } = await import("../../src/pr-lookup.js");

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    workspaceId: overrides.workspaceId ?? "api-a1b2",
    agent: "claude",
    prompt: "fix the bug",
    branch: "feature/native-pr-binding",
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

describe("session-pr", () => {
  beforeEach(() => {
    ghMock.mockReset();
    readCurrentBranchMock.mockReset().mockResolvedValue("feature/native-pr-binding");
    readRemoteUrlsMock
      .mockReset()
      .mockResolvedValue(new Map([["origin", "git@github.com:acme/api.git"]]));
    _resetPrLookupsForTests();
  });

  it("parses a GitHub PR URL into a native session binding", () => {
    expect(parseSessionPrBinding("https://github.com/acme/api/pull/42")).toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
  });

  it("imports a legacy pr slot into session.pr and strips the generic link", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          title: "Investigate CI",
          links: [
            { label: "tracker", url: "https://tracker.example.com/TASK-9" },
            { label: "pr", url: "https://github.com/acme/api/pull/42" },
          ],
        },
      }),
    );

    expect(normalized.pr).toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(normalized.slots).toEqual({
      title: "Investigate CI",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
  });

  it("imports a legacy github-pr slot into session.pr and strips it from slots", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          title: "Investigate CI",
          links: [
            { label: "tracker", url: "https://tracker.example.com/TASK-9" },
            { label: "github-pr", url: "https://github.com/acme/api/pull/42" },
          ],
        },
      }),
    );

    expect(normalized.pr).toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(normalized.slots).toEqual({
      title: "Investigate CI",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
  });

  it("keeps non-GitHub pr links as generic slots", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          links: [{ label: "pr", url: "https://example.com/claude/pull/1" }],
        },
      }),
    );

    expect(normalized.pr).toBeUndefined();
    expect(normalized.slots).toEqual({
      links: [{ label: "pr", url: "https://example.com/claude/pull/1" }],
    });
    expect(deriveSessionSlots(normalized)).toEqual(normalized.slots);
  });

  it("collapses legacy github-pr aliases into generic pr slots for non-GitHub URLs", () => {
    const normalized = normalizeSessionPrBinding(
      makeSession({
        slots: {
          links: [{ label: "github-pr", url: "https://gitlab.com/acme/api/-/merge_requests/7" }],
        },
      }),
    );

    expect(normalized.pr).toBeUndefined();
    expect(normalized.slots).toEqual({
      links: [{ label: "pr", url: "https://gitlab.com/acme/api/-/merge_requests/7" }],
    });
  });

  it("derives the display pr link from the native binding", () => {
    expect(
      deriveSessionSlots(
        makeSession({
          pr: {
            number: 42,
            repo: "acme/api",
            url: "https://github.com/acme/api/pull/42",
          },
          slots: {
            links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
          },
        }),
      ),
    ).toEqual({
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-9" },
        { label: "pr", url: "https://github.com/acme/api/pull/42" },
      ],
    });
  });

  it("discovers a binding with exactly one batched graphql call, not pr list", async () => {
    ghMock.mockResolvedValue(
      JSON.stringify({
        data: {
          rateLimit: { limit: 5000, cost: 1, remaining: 4900, resetAt: "2026-08-04T06:00:00Z" },
          r: {
            nameWithOwner: "acme/api",
            isFork: false,
            parent: null,
            a0: {
              nodes: [
                {
                  number: 42,
                  title: "Fix checkout",
                  url: "https://github.com/acme/api/pull/42",
                  state: "OPEN",
                },
              ],
            },
          },
        },
      }),
    );

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).resolves.toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });

    expect(ghMock).toHaveBeenCalledTimes(1);
    const call = ghMock.mock.calls[0] ?? [];
    expect(call[0]).toBe("/tmp/spur-worktrees/api-a1b2");
    expect(call[1]).toBe("api");
    expect(call[2]).toBe("graphql");
    expect(call).toContain("owner=acme");
    expect(call).toContain("name=api");
    expect(call).toContain("b0=feature/native-pr-binding");
    expect(call).not.toContain("list");
  });

  it("falls back to gh pr list when the remote yields no usable owner/name", async () => {
    // A GitHub Enterprise host Spur cannot recognize by name, or an ssh alias:
    // gh resolves the host itself, so ask it per branch instead of reporting
    // "no PR" and letting teardown delete the branch under an open PR.
    readRemoteUrlsMock.mockResolvedValue(new Map([["origin", "git@code.mycorp.com:acme/api.git"]]));
    ghMock.mockResolvedValue(
      JSON.stringify([
        { number: 42, title: "Fix checkout", url: "https://github.com/acme/api/pull/42" },
      ]),
    );

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).resolves.toEqual({
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(ghMock).toHaveBeenCalledWith(
      "/tmp/spur-worktrees/api-a1b2",
      "pr",
      "list",
      "--head",
      "feature/native-pr-binding",
      "--json",
      "number,title,url",
      "--limit",
      "1",
    );
  });

  it("returns null when the per-branch fallback finds no PR", async () => {
    readRemoteUrlsMock.mockResolvedValue(new Map());
    ghMock.mockResolvedValue("[]");

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).resolves.toBeNull();
  });

  it("throws instead of reporting no PR when the lookup is rate limited", async () => {
    ghMock.mockRejectedValue(
      new Error("gh: API rate limit exceeded for user ID 1; see the rate limit documentation"),
    );

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).rejects.toThrow(/rate limit exceeded/i);
  });

  it("throws instead of reporting no PR when GitHub answers HTTP 502", async () => {
    ghMock.mockRejectedValue(new Error("gh: HTTP 502: Bad gateway (https://api.github.com/graphql)"));

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the per-branch fallback itself fails", async () => {
    readRemoteUrlsMock.mockResolvedValue(new Map());
    ghMock.mockRejectedValue(new Error("gh: HTTP 502: Bad gateway"));

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("returns null for a branch whose newest PR is merged", async () => {
    ghMock.mockResolvedValue(
      JSON.stringify({
        data: {
          rateLimit: { limit: 5000, cost: 1, remaining: 4900, resetAt: "2026-08-04T06:00:00Z" },
          r: {
            nameWithOwner: "acme/api",
            isFork: false,
            parent: null,
            a0: {
              nodes: [
                {
                  number: 41,
                  title: "Old",
                  url: "https://github.com/acme/api/pull/41",
                  state: "MERGED",
                },
              ],
            },
          },
        },
      }),
    );

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).resolves.toBeNull();
    expect(ghMock).toHaveBeenCalledTimes(1);
  });

  it("views a session pull request state through gh", async () => {
    ghMock.mockResolvedValue(
      JSON.stringify({
        number: 42,
        state: "OPEN",
        title: "Fix checkout",
        url: "https://github.com/acme/api/pull/42",
      }),
    );

    await expect(
      viewSessionPrState("/repo/api", {
        number: 42,
        repo: "acme/api",
        url: "https://github.com/acme/api/pull/42",
      }),
    ).resolves.toEqual({
      number: 42,
      state: "OPEN",
      title: "Fix checkout",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(ghMock).toHaveBeenCalledWith(
      "/repo/api",
      "pr",
      "view",
      "42",
      "--json",
      "number,state,title,url",
    );
  });

  it("closes a session pull request through gh args", async () => {
    await closeSessionPr("/repo/api", {
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    });

    expect(ghMock).toHaveBeenCalledWith("/repo/api", "pr", "close", "42");
  });
});

describe("listOpenPullRequests", () => {
  beforeEach(() => {
    ghMock.mockReset();
  });

  it("lists open PRs by number and head branch", async () => {
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        { number: 1, headRefName: "feature/a" },
        { number: 2, headRefName: "feature/b" },
      ]),
    );

    await expect(listOpenPullRequests("acme/api")).resolves.toEqual([
      { number: 1, headRefName: "feature/a" },
      { number: 2, headRefName: "feature/b" },
    ]);
    expect(ghMock).toHaveBeenCalledWith(
      process.cwd(),
      "pr",
      "list",
      "--repo",
      "acme/api",
      "--state",
      "open",
      "--json",
      "number,headRefName",
      "--limit",
      "1000",
    );
  });

  it("throws on invalid JSON", async () => {
    ghMock.mockResolvedValueOnce("not json");
    await expect(listOpenPullRequests("acme/api")).rejects.toThrow(/invalid JSON/);
  });

  it("throws on a non-array payload", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify({ number: 1 }));
    await expect(listOpenPullRequests("acme/api")).rejects.toThrow(/non-array/);
  });

  it("throws on an item with an unexpected shape", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify([{ number: 1 }]));
    await expect(listOpenPullRequests("acme/api")).rejects.toThrow(/unexpected shape/);
  });

  it("throws when the result count saturates the limit", async () => {
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        { number: 1, headRefName: "a" },
        { number: 2, headRefName: "b" },
      ]),
    );
    await expect(listOpenPullRequests("acme/api", 2)).rejects.toThrow(/unresolvable/);
  });

  it("propagates a gh call failure", async () => {
    ghMock.mockRejectedValueOnce(new Error("gh not authenticated"));
    await expect(listOpenPullRequests("acme/api")).rejects.toThrow(/gh not authenticated/);
  });
});

describe("resolveRepoSlug", () => {
  beforeEach(() => {
    ghMock.mockReset();
  });

  it("resolves the nameWithOwner slug", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify({ nameWithOwner: "acme/api" }));

    await expect(resolveRepoSlug("/repo/api")).resolves.toBe("acme/api");
    expect(ghMock).toHaveBeenCalledWith("/repo/api", "repo", "view", "--json", "nameWithOwner");
  });

  it("throws on invalid JSON", async () => {
    ghMock.mockResolvedValueOnce("not json");
    await expect(resolveRepoSlug("/repo/api")).rejects.toThrow(/invalid JSON/);
  });

  it("throws when nameWithOwner is missing", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify({}));
    await expect(resolveRepoSlug("/repo/api")).rejects.toThrow(/unexpected shape/);
  });
});
