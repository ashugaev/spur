import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGcDeps, executeSessionGc, planSessionGc } from "../../src/session-gc.js";
import type { AppConfig, SessionRecord } from "../../src/types.js";

const listOpenPullRequestsMock = vi.hoisted(() => vi.fn());
const resolveRepoSlugMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/session-pr.js", () => ({
  listOpenPullRequests: listOpenPullRequestsMock,
  resolveRepoSlug: resolveRepoSlugMock,
}));

const NOW = new Date("2026-08-01T00:00:00.000Z");

function record(
  id: string,
  number: number,
  repo: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    project: "api",
    workspaceId: id,
    agent: "claude",
    prompt: "ship it",
    branch: id,
    worktree: false,
    worktreePath: "/repo/api",
    tmuxSession: id,
    launchCommand: "claude",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pr: { number, repo, url: `https://github.com/${repo}/pull/${number}` },
    ...overrides,
  };
}

// Only the PR index under test is real; every other dep is a fake.
async function run(records: SessionRecord[]) {
  const config = { dataDir: "/nonexistent", projects: {} } as unknown as AppConfig;
  const archiveGroup = vi.fn((members: readonly { id: string }[]) => ({
    archivedIds: members.map((member) => member.id),
  }));
  const report = await executeSessionGc(
    planSessionGc({
      sessions: records,
      worktreeDir: "/data/worktrees",
      now: NOW,
      olderThanDays: 30,
      statuses: ["completed", "killed", "stopped"],
      limit: 100,
      pathExists: () => true,
    }),
    {
      ...createGcDeps(config),
      cwd: "/home/dev",
      readGroupMembers: (ids) => ids.map((id) => records.find((r) => r.id === id) ?? null),
      listSessionRecords: () => records,
      checkGroupLiveness: () => "inactive",
      archiveGroup,
    },
    { dryRun: false, sizes: false },
  );
  return { report, archiveGroup };
}

describe("createGcDeps openPrIndex across repos", () => {
  beforeEach(() => {
    listOpenPullRequestsMock.mockReset();
    resolveRepoSlugMock.mockReset();
  });

  it("keeps a record bound to an open PR in a second repo while archiving the closed-PR one", async () => {
    listOpenPullRequestsMock.mockImplementation(async (repo: string) =>
      repo === "acme/two" ? [{ number: 22, headRefName: "other" }] : [],
    );

    const { report, archiveGroup } = await run([
      record("A", 11, "acme/one"),
      record("B", 22, "acme/two"),
    ]);

    expect(archiveGroup.mock.calls[0]?.[0].map((member) => member.id)).toEqual(["A"]);
    expect(report.groups[0]?.blockReasons).toContain("open_pr");
  });

  it("does not confuse the same PR number in another repo", async () => {
    listOpenPullRequestsMock.mockImplementation(async (repo: string) =>
      repo === "acme/two" ? [{ number: 11, headRefName: "other" }] : [],
    );

    const { archiveGroup } = await run([record("A", 11, "acme/one"), record("B", 22, "acme/two")]);

    expect(archiveGroup.mock.calls[0]?.[0].map((member) => member.id).sort()).toEqual(["A", "B"]);
  });

  it("matches an open branch only in its own repo", async () => {
    listOpenPullRequestsMock.mockImplementation(async (repo: string) =>
      repo === "acme/two" ? [{ number: 99, headRefName: "feature/shared" }] : [],
    );

    const { report, archiveGroup } = await run([
      record("A", 11, "acme/one", { branch: "feature/shared" }),
      record("B", 22, "acme/two", { branch: "feature/shared" }),
    ]);

    expect(archiveGroup.mock.calls[0]?.[0].map((member) => member.id)).toEqual(["A"]);
    expect(report.groups[0]?.blockReasons).toContain("open_pr");
  });

  it("matches an unbound member's branch against the checkout repo only", async () => {
    resolveRepoSlugMock.mockResolvedValue("acme/one");
    listOpenPullRequestsMock.mockImplementation(async (repo: string) =>
      repo === "acme/two" ? [{ number: 99, headRefName: "feature/shared" }] : [],
    );
    // "/tmp" exists, so the checkout repo resolves for the unbound member.
    const unbound = record("C", 0, "acme/one", { branch: "feature/shared", worktreePath: "/tmp" });
    delete unbound.pr;
    const { archiveGroup } = await run([
      unbound,
      record("D", 22, "acme/two", { branch: "other", worktreePath: "/tmp" }),
    ]);

    expect(archiveGroup.mock.calls[0]?.[0].map((member) => member.id).sort()).toEqual(["C", "D"]);
  });

  it("blocks the whole group when any bound repo cannot be listed", async () => {
    listOpenPullRequestsMock.mockImplementation(async (repo: string) => {
      if (repo === "acme/two") throw new Error("gh failed");
      return [];
    });

    const { report, archiveGroup } = await run([
      record("A", 11, "acme/one"),
      record("B", 22, "acme/two"),
    ]);

    expect(archiveGroup).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["probe_failed"]);
  });
});
