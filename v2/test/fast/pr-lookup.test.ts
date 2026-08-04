import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as fsModule from "node:fs";
import type * as ghModule from "../../src/gh.js";
import type { PrLookupOutcome, PrLookupRequest } from "../../src/pr-lookup.js";
import type { PrRepoSlug } from "../../src/pr-lookup-cache.js";

const { ghMock, readRemoteUrlsMock, existsSyncMock, logSpurEventMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  readRemoteUrlsMock: vi.fn(),
  existsSyncMock: vi.fn((_path: string) => true),
  logSpurEventMock: vi.fn(),
}));

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readRemoteUrls: readRemoteUrlsMock,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fsModule>()),
  existsSync: existsSyncMock,
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

const {
  _resetPrLookupsForTests,
  buildAliasedBranchQuery,
  cancelPendingPrLookups,
  enqueuePrLookup,
  flushPrLookups,
  parseRepoSlugFromRemoteUrl,
  resolvePrLookupRepo,
  resolvePrLookups,
} = await import("../../src/pr-lookup.js");
const {
  GH_POLL_MIN_GRAPHQL_REMAINING,
  _resetGhUsageForTests,
  noteGhInvocation,
  noteGitHubRateLimitHit,
  recordGraphqlBudget,
  runGhPollCycle,
  setGhEventSink,
} = await import("../../src/gh.js");

const SLUG: PrRepoSlug = { host: "github.com", owner: "ashugaev", name: "spur" };
const OTHER_SLUG: PrRepoSlug = { host: "github.com", owner: "ashugaev", name: "other" };
const CWD = "/tmp/spur-worktrees/api-a1b2";

function prNode(number: number, state: "OPEN" | "CLOSED" | "MERGED"): unknown {
  return {
    number,
    title: `pr ${number}`,
    url: `https://github.com/ashugaev/spur/pull/${number}`,
    state,
  };
}

function envelope(
  aliasNodes: Record<string, unknown[]>,
  overrides: { remaining?: number; repo?: Record<string, unknown> | null; errors?: unknown } = {},
): string {
  const repo =
    overrides.repo === undefined
      ? {
          nameWithOwner: "ashugaev/spur",
          isFork: false,
          parent: null,
          ...Object.fromEntries(
            Object.entries(aliasNodes).map(([alias, nodes]) => [alias, { nodes }]),
          ),
        }
      : overrides.repo;
  return JSON.stringify({
    data: {
      rateLimit: {
        limit: 5000,
        cost: 1,
        remaining: overrides.remaining ?? 4_800,
        resetAt: "2026-08-04T06:00:00Z",
      },
      r: repo,
    },
    ...(overrides.errors === undefined ? {} : { errors: overrides.errors }),
  });
}

function requestsFor(branches: string[], slug: PrRepoSlug = SLUG): PrLookupRequest[] {
  return branches.map((branch) => ({ slug, branch, worktreePath: CWD }));
}

function allNodesEmpty(count: number): Record<string, unknown[]> {
  return Object.fromEntries(
    Array.from({ length: count }, (_unused, index) => [`a${index}`, []]),
  ) as Record<string, unknown[]>;
}

describe("pr lookup batching", () => {
  beforeEach(() => {
    ghMock.mockReset();
    readRemoteUrlsMock.mockReset().mockResolvedValue(new Map());
    existsSyncMock.mockReset().mockReturnValue(true);
    _resetPrLookupsForTests();
    _resetGhUsageForTests();
    logSpurEventMock.mockReset();
    setGhEventSink("/tmp/spur-data");
  });

  afterEach(() => {
    _resetPrLookupsForTests();
    _resetGhUsageForTests();
  });

  it("resolves 120 branches in one repo with exactly 3 gh api graphql calls", async () => {
    ghMock.mockImplementation((_cwd: string, ...args: string[]) => {
      const branchArgs = args.filter((arg) => /^b\d+=/.test(arg));
      return Promise.resolve(envelope(allNodesEmpty(branchArgs.length)));
    });

    const branches = Array.from({ length: 120 }, (_unused, index) => `feature/${index}`);
    const outcomes = await resolvePrLookups(requestsFor(branches));

    expect(ghMock).toHaveBeenCalledTimes(3);
    for (const call of ghMock.mock.calls) {
      expect(call[0]).toBe(CWD);
      expect(call[1]).toBe("api");
      expect(call.slice(1, 4)).toEqual(["api", "--hostname", "github.com"]);
      expect(call[4]).toBe("graphql");
    }
    expect(outcomes).toHaveLength(120);
    expect(outcomes.every((outcome) => outcome.status === "absent")).toBe(true);
  });

  it("issues one call per repo", async () => {
    ghMock.mockResolvedValue(envelope({ a0: [] }));

    await resolvePrLookups([
      ...requestsFor(["feature/a"]),
      ...requestsFor(["feature/b"], OTHER_SLUG),
    ]);

    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(ghMock.mock.calls[0]).toContain("owner=ashugaev");
    expect(ghMock.mock.calls[0]).toContain("name=spur");
    expect(ghMock.mock.calls[1]).toContain("name=other");
  });

  it("groups identical owner/repo names by GitHub hostname", async () => {
    const enterprise = { ...SLUG, host: "git.corp.internal" };
    ghMock.mockResolvedValue(envelope({ a0: [] }));

    await resolvePrLookups([
      ...requestsFor(["feature/public"]),
      ...requestsFor(["feature/enterprise"], enterprise),
    ]);

    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(ghMock.mock.calls.map((call) => call[3])).toEqual(["github.com", "git.corp.internal"]);
  });

  it("collapses duplicate branches into one alias", async () => {
    ghMock.mockResolvedValue(envelope({ a0: [prNode(7, "OPEN")] }));

    const outcomes = await resolvePrLookups(requestsFor(["feature/dupe", "feature/dupe"]));

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(ghMock.mock.calls[0]?.filter((arg: string) => /^b\d+=/.test(String(arg)))).toEqual([
      "b0=feature/dupe",
    ]);
    expect(outcomes[0]).toEqual({
      status: "found",
      pr: {
        number: 7,
        title: "pr 7",
        url: "https://github.com/ashugaev/spur/pull/7",
        state: "OPEN",
      },
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it("maps open, merged and absent branches to found, terminal and absent", async () => {
    ghMock.mockResolvedValue(
      envelope({
        a0: [prNode(10, "OPEN")],
        a1: [prNode(11, "MERGED"), prNode(9, "CLOSED")],
        a2: [],
      }),
    );

    const outcomes = await resolvePrLookups(
      requestsFor(["feature/open", "feature/merged", "feature/none"]),
    );

    expect(outcomes[0]?.status).toBe("found");
    expect(outcomes[1]).toEqual({ status: "terminal", pr: { number: 11, state: "MERGED" } });
    expect(outcomes[2]).toEqual({ status: "absent" });
  });

  it("prefers the open PR even when a newer one is closed", async () => {
    ghMock.mockResolvedValue(envelope({ a0: [prNode(12, "CLOSED"), prNode(8, "OPEN")] }));

    const outcomes = await resolvePrLookups(requestsFor(["feature/reopened"]));

    expect(outcomes[0]).toMatchObject({ status: "found", pr: { number: 8 } });
  });

  it("skips a per-alias error while siblings still resolve", async () => {
    const error: Error & { stdout?: string } = new Error("gh: something went wrong");
    error.stdout = envelope(
      { a0: [prNode(21, "OPEN")], a1: [] },
      {
        errors: [
          { type: "INTERNAL", path: ["r", "a1"], message: "timeout resolving pullRequests" },
          { type: "INTERNAL", path: ["nope"], message: "unattributable" },
        ],
      },
    );
    ghMock.mockRejectedValue(error);

    const outcomes = await resolvePrLookups(requestsFor(["feature/ok", "feature/broken"]));

    expect(outcomes[0]).toMatchObject({ status: "found", pr: { number: 21 } });
    expect(outcomes[1]).toEqual({
      status: "skipped",
      reason: "error",
      message: "timeout resolving pullRequests",
    });
  });

  it("skips every branch when the response has no data envelope", async () => {
    ghMock.mockRejectedValue(new Error("gh: HTTP 502"));

    const outcomes = await resolvePrLookups(requestsFor(["feature/a", "feature/b"]));

    expect(outcomes.every((outcome) => outcome.status === "skipped")).toBe(true);
    expect(outcomes[0]).toMatchObject({ reason: "error" });
  });

  it("skips with repo_unresolved when the repository field is null", async () => {
    ghMock.mockResolvedValue(envelope({}, { repo: null }));

    const outcomes = await resolvePrLookups(requestsFor(["feature/a"]));

    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "repo_unresolved" });
  });

  it("retries a fork against its parent in the same resolve", async () => {
    ghMock
      .mockResolvedValueOnce(
        envelope(
          {},
          {
            repo: {
              isFork: true,
              parent: { nameWithOwner: "upstream-org/spur" },
              a0: { nodes: [] },
            },
          },
        ),
      )
      .mockResolvedValueOnce(envelope({ a0: [prNode(77, "OPEN")] }));

    const outcomes = await resolvePrLookups(requestsFor(["feature/a"]));

    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(ghMock.mock.calls[1]).toContain("owner=upstream-org");
    expect(outcomes[0]).toMatchObject({ status: "found", pr: { number: 77 } });
  });

  it("never answers absent for a fork whose parent is also a fork", async () => {
    ghMock.mockResolvedValue(
      envelope(
        {},
        {
          repo: {
            isFork: true,
            parent: { nameWithOwner: "upstream-org/spur" },
            a0: { nodes: [] },
          },
        },
      ),
    );

    const outcomes = await resolvePrLookups(requestsFor(["feature/a"]));

    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "repo_unresolved" });
  });

  it("skips a branch whose nodes came back unreadable instead of recording absent", async () => {
    ghMock.mockResolvedValue(envelope({ a0: [null] }));

    const outcomes = await resolvePrLookups(requestsFor(["feature/a"]));

    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "error" });
  });

  it("uses a worktree that still exists as gh's cwd for the repo's batch", async () => {
    ghMock.mockResolvedValue(envelope({ a0: [], a1: [] }));
    existsSyncMock.mockImplementation((path: string) => path !== "/tmp/gone");

    await resolvePrLookups([
      { slug: SLUG, branch: "feature/a", worktreePath: "/tmp/gone" },
      { slug: SLUG, branch: "feature/b", worktreePath: CWD },
    ]);

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(ghMock.mock.calls[0]?.[0]).toBe(CWD);
  });

  it("spends zero gh calls and skips on budget when the ledger is blocked", async () => {
    recordGraphqlBudget(GH_POLL_MIN_GRAPHQL_REMAINING - 1, Date.now() + 600_000);

    const outcomes = await Promise.all([
      enqueuePrLookup({ slug: SLUG, branch: "feature/a", worktreePath: CWD }),
      enqueuePrLookup({ slug: SLUG, branch: "feature/b", worktreePath: CWD }),
      flushPrLookups().then<PrLookupOutcome>(() => ({ status: "absent" })),
    ]);

    expect(ghMock).toHaveBeenCalledTimes(0);
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "budget" });
    expect(outcomes[1]).toMatchObject({ status: "skipped", reason: "budget" });
  });

  it("blocks the queued path but not the interactive path during a cooldown", async () => {
    noteGitHubRateLimitHit();
    ghMock.mockResolvedValue(envelope({ a0: [prNode(31, "OPEN")] }));

    const queued = enqueuePrLookup({ slug: SLUG, branch: "feature/a", worktreePath: CWD });
    await flushPrLookups();
    expect(await queued).toMatchObject({ status: "skipped", reason: "budget" });
    expect(ghMock).toHaveBeenCalledTimes(0);

    const direct = await resolvePrLookups(requestsFor(["feature/a"]));
    expect(direct[0]).toMatchObject({ status: "found" });
    expect(ghMock).toHaveBeenCalledTimes(1);
  });

  it("flushes a full chunk without waiting for the sweep", async () => {
    ghMock.mockImplementation((_cwd: string, ...args: string[]) => {
      const branchArgs = args.filter((arg) => /^b\d+=/.test(arg));
      return Promise.resolve(envelope(allNodesEmpty(branchArgs.length)));
    });

    const promises = Array.from({ length: 50 }, (_unused, index) =>
      enqueuePrLookup({ slug: SLUG, branch: `feature/${index}`, worktreePath: CWD }),
    );
    const outcomes = await Promise.all(promises);

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(outcomes.every((outcome) => outcome.status === "absent")).toBe(true);
  });

  it("drains an auto-flush before emitting the poll-cycle cost", async () => {
    let release = (_value: string): void => {
      throw new Error("auto-flush did not start");
    };
    ghMock.mockImplementation((_cwd: string, ...args: string[]) => {
      noteGhInvocation(args);
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    const cycle = runGhPollCycle({ kind: "attention" }, async () => {
      const outcomes = Array.from({ length: 50 }, (_unused, index) =>
        enqueuePrLookup({ slug: SLUG, branch: `feature/${index}`, worktreePath: CWD }),
      );
      await flushPrLookups();
      await Promise.all(outcomes);
    });
    await vi.waitFor(() => expect(ghMock).toHaveBeenCalledTimes(1));
    expect(logSpurEventMock).not.toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({ event: "gh.poll_cycle" }),
    );
    release(envelope(allNodesEmpty(50)));
    await cycle;

    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "gh.poll_cycle",
        details: expect.objectContaining({ calls: 1, graphqlCost: 1 }),
      }),
    );
  });

  it("cancels pending lookups without leaving a promise unsettled", async () => {
    const promise = enqueuePrLookup({ slug: SLUG, branch: "feature/a", worktreePath: CWD });
    cancelPendingPrLookups();

    expect(await promise).toEqual({ status: "skipped", reason: "cancelled" });
    expect(ghMock).toHaveBeenCalledTimes(0);
  });

  it("resolves the repo slug from upstream first, then origin, in one git spawn", async () => {
    readRemoteUrlsMock.mockResolvedValue(
      new Map([
        ["origin", "git@github.com:fork-org/spur.git"],
        ["upstream", "https://github.com/base-org/spur.git"],
      ]),
    );

    await expect(resolvePrLookupRepo(CWD)).resolves.toEqual({
      host: "github.com",
      owner: "base-org",
      name: "spur",
    });
    await expect(resolvePrLookupRepo(CWD)).resolves.toEqual({
      host: "github.com",
      owner: "base-org",
      name: "spur",
    });
    expect(readRemoteUrlsMock).toHaveBeenCalledTimes(1);
  });

  it("returns null and spends no gh call when no remote resolves", async () => {
    readRemoteUrlsMock.mockResolvedValue(new Map());

    await expect(resolvePrLookupRepo(CWD)).resolves.toBeNull();
    expect(ghMock).toHaveBeenCalledTimes(0);
    expect(readRemoteUrlsMock).toHaveBeenCalledTimes(1);
  });

  it("expires a memoized miss in seconds and never blackholes a repo for the full TTL", async () => {
    const t0 = 1_800_000_000_000;
    // One transient git failure looks exactly like "no remote".
    readRemoteUrlsMock.mockResolvedValueOnce(new Map());
    await expect(resolvePrLookupRepo(CWD, { nowMs: t0 })).resolves.toBeNull();

    readRemoteUrlsMock.mockResolvedValue(new Map([["origin", "git@github.com:ashugaev/spur.git"]]));
    // Inside the miss TTL the memo still answers null, but only for seconds.
    await expect(resolvePrLookupRepo(CWD, { nowMs: t0 + 5_000 })).resolves.toBeNull();
    await expect(resolvePrLookupRepo(CWD, { nowMs: t0 + 20_000 })).resolves.toEqual(SLUG);
  });

  it("lets an interactive caller bypass a memoized miss outright", async () => {
    const t0 = 1_800_000_000_000;
    readRemoteUrlsMock.mockResolvedValueOnce(new Map());
    await expect(resolvePrLookupRepo(CWD, { nowMs: t0 })).resolves.toBeNull();

    readRemoteUrlsMock.mockResolvedValue(new Map([["origin", "git@github.com:ashugaev/spur.git"]]));
    await expect(
      resolvePrLookupRepo(CWD, { nowMs: t0 + 1_000, bypassMissMemo: true }),
    ).resolves.toEqual(SLUG);
  });

  it("keeps a resolved slug memoized for the full TTL", async () => {
    const t0 = 1_800_000_000_000;
    readRemoteUrlsMock.mockResolvedValue(new Map([["origin", "git@github.com:ashugaev/spur.git"]]));

    await expect(resolvePrLookupRepo(CWD, { nowMs: t0 })).resolves.toEqual(SLUG);
    await expect(
      resolvePrLookupRepo(CWD, { nowMs: t0 + 29 * 60_000, bypassMissMemo: true }),
    ).resolves.toEqual(SLUG);
    expect(readRemoteUrlsMock).toHaveBeenCalledTimes(1);
  });

  it("parses ssh, https, enterprise and ssh-alias remotes", () => {
    expect(parseRepoSlugFromRemoteUrl("git@github.com:ashugaev/spur.git")).toEqual(SLUG);
    expect(parseRepoSlugFromRemoteUrl("https://github.com/ashugaev/spur")).toEqual(SLUG);
    expect(parseRepoSlugFromRemoteUrl("ssh://git@github.com/ashugaev/spur.git")).toEqual(SLUG);
    expect(parseRepoSlugFromRemoteUrl("git@github-work:ashugaev/spur.git")).toEqual({
      ...SLUG,
      host: "github-work",
    });
    // GitHub Enterprise hosts.
    expect(parseRepoSlugFromRemoteUrl("https://github.mycorp.com/ashugaev/spur.git")).toEqual({
      ...SLUG,
      host: "github.mycorp.com",
    });
    expect(parseRepoSlugFromRemoteUrl("git@github.corp.example:ashugaev/spur.git")).toEqual({
      ...SLUG,
      host: "github.corp.example",
    });
    expect(parseRepoSlugFromRemoteUrl("https://github.mycorp.com:8443/ashugaev/spur")).toEqual({
      ...SLUG,
      host: "github.mycorp.com",
    });
    expect(parseRepoSlugFromRemoteUrl("git@git.corp.internal:ashugaev/spur.git")).toEqual({
      ...SLUG,
      host: "git.corp.internal",
    });
    expect(parseRepoSlugFromRemoteUrl("https://gitlab.com/ashugaev/spur.git")).toBeNull();
    expect(parseRepoSlugFromRemoteUrl("git@bitbucket.org:ashugaev/spur.git")).toBeNull();
    expect(parseRepoSlugFromRemoteUrl("/srv/repos/spur")).toBeNull();
    expect(parseRepoSlugFromRemoteUrl("not a url")).toBeNull();
  });

  it("builds one alias per branch inside a single repository block", () => {
    const { query, aliases } = buildAliasedBranchQuery(["feature/a", "feature/b"]);

    expect(aliases).toEqual([
      { alias: "a0", branch: "feature/a" },
      { alias: "a1", branch: "feature/b" },
    ]);
    expect(query).toContain("rateLimit{cost remaining resetAt}");
    expect(query).toContain("r: repository(owner:$owner,name:$name)");
    expect(query).toContain("a0: pullRequests(headRefName:$b0,first:5");
    expect(query).toContain("a1: pullRequests(headRefName:$b1,first:5");
    // Well under the 131072-byte single-argv ceiling even at 50 aliases.
    expect(
      buildAliasedBranchQuery(Array.from({ length: 50 }, (_u, i) => `feature/${i}`)).query.length,
    ).toBeLessThan(16_000);
  });
});
