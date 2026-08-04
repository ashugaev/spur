import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/types.js";

const { ghMock, readCurrentBranchMock, readRemoteUrlMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  readCurrentBranchMock: vi.fn(),
  readRemoteUrlMock: vi.fn(),
}));

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gh.js")>()),
  gh: ghMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: readCurrentBranchMock,
  readRemoteUrl: readRemoteUrlMock,
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
    readRemoteUrlMock
      .mockReset()
      .mockImplementation((_path: string, remote: string) =>
        Promise.resolve(remote === "origin" ? "git@github.com:acme/api.git" : null),
      );
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

  it("returns null without a gh call when no github remote resolves", async () => {
    readRemoteUrlMock.mockResolvedValue(null);

    await expect(
      discoverSessionPrBinding("/tmp/spur-worktrees/api-a1b2", "feature/native-pr-binding"),
    ).resolves.toBeNull();
    expect(ghMock).toHaveBeenCalledTimes(0);
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
