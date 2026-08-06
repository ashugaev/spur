import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ghModule from "../../src/gh.js";
import type * as metadataModule from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";

// Same harness as github-helpers.test.ts:20-33: gh is a partial mock of
// src/gh.js, workspace.js is fully mocked so every session resolves to one
// repo slug. This file additionally partial-mocks metadata.js so T4 can force
// `readCommentSeenRegistry` to throw on its second call per batch, which the
// real implementation (a real file read) cannot be made to do without
// fabricating a corrupt registry file.
const { ghMock, readCommentSeenRegistryMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  readCommentSeenRegistryMock: vi.fn(() => new Set<string>()),
}));
vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: vi.fn(),
  readRemoteUrls: vi.fn().mockResolvedValue(new Map([["origin", "git@github.com:acme/api.git"]])),
  isGitWorktree: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof metadataModule>()),
  readCommentSeenRegistry: readCommentSeenRegistryMock,
}));

const { _resetGitHubReviewBatchForTests, collectGitHubSignalsBatch } =
  await import("../../src/review-providers/github.js");
const { _resetPrLookupsForTests, claimPollPrLookup } = await import("../../src/pr-lookup.js");
const { _resetPrLookupCacheForTests, PR_LOOKUP_LIVE_CAP_MS } =
  await import("../../src/pr-lookup-cache.js");
const { _resetGhUsageForTests } = await import("../../src/gh.js");

const SLUG = { host: "github.com", owner: "acme", name: "api" };

interface OpenPr {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

/**
 * Builds a graphql envelope for whatever `b<N>=<branch>` aliases the batched
 * query actually asked for, keyed by branch name so the alias index a caller
 * ends up with never has to be predicted.
 */
function reviewBatchEnvelope(args: string[], prByBranch: Record<string, OpenPr> = {}): string {
  const repo: Record<string, unknown> = {};
  for (const arg of args) {
    const match = /^b(\d+)=([\s\S]*)$/.exec(arg);
    if (!match) continue;
    const branch = match[2] ?? "";
    const pr = prByBranch[branch];
    repo[`a${match[1]}`] = {
      nodes: pr
        ? [
            {
              number: pr.number,
              title: pr.title,
              url: pr.url,
              state: pr.state,
              reviewDecision: null,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              isDraft: false,
              commits: { nodes: [] },
              reviewThreads: { nodes: [] },
              reviews: { nodes: [] },
              comments: { nodes: [] },
            },
          ]
        : [],
    };
  }
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 4_900, resetAt: "2026-08-04T18:00:00.000Z" },
      r: repo,
    },
  });
}

function unboundSession(id: string, branch: string): SessionRecord {
  return {
    id,
    project: "api",
    workspaceId: id,
    agent: "claude",
    prompt: "hello",
    branch,
    worktree: true,
    worktreePath: `/tmp/${id}`,
    tmuxSession: id,
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
  };
}

describe("GitHub review batch claim scoping", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    ghMock.mockReset();
    readCommentSeenRegistryMock.mockReset().mockReturnValue(new Set());
    _resetGitHubReviewBatchForTests();
    _resetPrLookupsForTests();
    _resetPrLookupCacheForTests();
    _resetGhUsageForTests();
  });

  afterEach(async () => {
    _resetGitHubReviewBatchForTests();
    _resetPrLookupsForTests();
    _resetPrLookupCacheForTests();
    _resetGhUsageForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-review-claims-"));
    tempDirs.push(dataDir);
    return dataDir;
  }

  it("T1: a branch held by a third-party claim is reported cached, not awaited", async () => {
    const dataDir = await makeDataDir();
    const sessions = [
      unboundSession("api-1", "feature/b1"),
      unboundSession("api-2", "feature/b2"),
      unboundSession("api-3", "feature/b3"),
    ];
    const held1 = claimPollPrLookup({
      dataDir,
      slug: SLUG,
      branch: "feature/b1",
      capMs: PR_LOOKUP_LIVE_CAP_MS,
    });
    const held2 = claimPollPrLookup({
      dataDir,
      slug: SLUG,
      branch: "feature/b2",
      capMs: PR_LOOKUP_LIVE_CAP_MS,
    });
    if (held1.status !== "owner" || held2.status !== "owner") {
      throw new Error("setup: expected fresh owner claims on branches 1 and 2");
    }
    // held1 and held2 are never settled: they are the third-party holders
    // this actor must never await.
    ghMock.mockImplementation((_cwd: string, ...args: string[]) =>
      Promise.resolve(reviewBatchEnvelope(args)),
    );

    const result = await collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");

    expect(result.get("api-1")).toEqual({ status: "skipped", reason: "cached" });
    expect(result.get("api-2")).toEqual({ status: "skipped", reason: "cached" });
    expect(result.get("api-3")?.status).toBe("ok");
  });

  it("T2: the batched query names only the branch this actor owns", async () => {
    const dataDir = await makeDataDir();
    const sessions = [
      unboundSession("api-1", "feature/b1"),
      unboundSession("api-2", "feature/b2"),
      unboundSession("api-3", "feature/b3"),
    ];
    const held1 = claimPollPrLookup({
      dataDir,
      slug: SLUG,
      branch: "feature/b1",
      capMs: PR_LOOKUP_LIVE_CAP_MS,
    });
    const held2 = claimPollPrLookup({
      dataDir,
      slug: SLUG,
      branch: "feature/b2",
      capMs: PR_LOOKUP_LIVE_CAP_MS,
    });
    if (held1.status !== "owner" || held2.status !== "owner") {
      throw new Error("setup: expected fresh owner claims on branches 1 and 2");
    }
    ghMock.mockImplementation((_cwd: string, ...args: string[]) =>
      Promise.resolve(reviewBatchEnvelope(args)),
    );

    await collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");

    expect(ghMock).toHaveBeenCalledTimes(1);
    const call = ghMock.mock.calls[0] ?? [];
    const branchArgs = call.filter((arg: unknown) => /^b\d+=/.test(String(arg)));
    expect(branchArgs).toEqual(["b0=feature/b3"]);
  });

  it("T4: a throw in the alias loop releases every claim the batch owned", async () => {
    const dataDir = await makeDataDir();
    const sessions = [
      unboundSession("api-1", "feature/t4-1"),
      unboundSession("api-2", "feature/t4-2"),
      unboundSession("api-3", "feature/t4-3"),
    ];
    ghMock.mockImplementation((_cwd: string, ...args: string[]) =>
      Promise.resolve(
        reviewBatchEnvelope(args, {
          "feature/t4-1": {
            number: 1,
            title: "PR 1",
            url: "https://github.com/acme/api/pull/1",
            state: "OPEN",
          },
          "feature/t4-2": {
            number: 2,
            title: "PR 2",
            url: "https://github.com/acme/api/pull/2",
            state: "OPEN",
          },
          "feature/t4-3": {
            number: 3,
            title: "PR 3",
            url: "https://github.com/acme/api/pull/3",
            state: "OPEN",
          },
        }),
      ),
    );
    // First call (github.ts:913, inside the pagination try/catch) passes
    // through; the second call (github.ts:502, via the unguarded alias loop
    // at :1327) throws, leaking every not-yet-settled claim pre-fix.
    readCommentSeenRegistryMock
      .mockReset()
      .mockImplementationOnce(() => new Set<string>())
      .mockImplementation(() => {
        throw new Error("comment registry unavailable");
      });

    await expect(collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch")).rejects.toThrow(
      "comment registry unavailable",
    );

    for (const session of sessions) {
      const claim = claimPollPrLookup({
        dataDir,
        slug: SLUG,
        branch: session.branch,
        capMs: PR_LOOKUP_LIVE_CAP_MS,
      });
      expect(claim.status).toBe("owner");
    }
  });

  it("T5: two concurrent batches over one repo with a third-party holder both resolve", async () => {
    const dataDir = await makeDataDir();
    const sessions = Array.from({ length: 5 }, (_unused, index) =>
      unboundSession(`api-${index + 1}`, `feature/t5-${index + 1}`),
    );
    ghMock.mockImplementation((_cwd: string, ...args: string[]) =>
      Promise.resolve(reviewBatchEnvelope(args)),
    );

    // Third-party holder on the second branch in insertion order (index 1):
    // correction 6's precondition for the two-actor rotation to cross.
    const secondBranch = sessions[1]?.branch;
    if (!secondBranch) throw new Error("setup: expected a second session");
    const holder = claimPollPrLookup({
      dataDir,
      slug: SLUG,
      branch: secondBranch,
      capMs: PR_LOOKUP_LIVE_CAP_MS,
    });
    if (holder.status !== "owner") {
      throw new Error("setup: expected a fresh owner claim on the second branch");
    }

    const callA = collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
    const callB = collectGitHubSignalsBatch(sessions, dataDir, "api", "pr-watch");
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
    holder.settle({ status: "skipped", reason: "error" });

    const [resultA, resultB] = await Promise.all([callA, callB]);

    for (const result of [resultA, resultB]) {
      for (const outcome of result.values()) {
        expect(outcome.status).not.toBe("error");
      }
    }
  }, 5000);
});
