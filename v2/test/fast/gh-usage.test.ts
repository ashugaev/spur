import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logSpurEventMock } = vi.hoisted(() => ({
  logSpurEventMock: vi.fn(),
}));

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

const {
  GH_POLL_MIN_GRAPHQL_REMAINING,
  _resetGhUsageForTests,
  noteGhInvocation,
  noteGitHubRateLimitHit,
  noteGraphqlCost,
  pollBudgetState,
  recordGraphqlBudget,
  runGhPollCycle,
  setGhEventSink,
} = await import("../../src/gh.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000;

function usageEvents(window: "minute" | "hour"): Array<Record<string, unknown>> {
  return logSpurEventMock.mock.calls
    .map((call) => call[1] as { event: string; details?: Record<string, unknown> })
    .filter((entry) => entry.event === "gh.usage" && entry.details?.["window"] === window)
    .map((entry) => entry.details ?? {});
}

function pausedEvents(): Array<Record<string, unknown>> {
  return logSpurEventMock.mock.calls
    .map((call) => call[1] as { event: string; details?: Record<string, unknown> })
    .filter((entry) => entry.event === "gh.poll_budget_paused")
    .map((entry) => entry.details ?? {});
}

function cycleEvents(): Array<Record<string, unknown>> {
  return logSpurEventMock.mock.calls
    .map((call) => call[1] as { event: string; details?: Record<string, unknown> })
    .filter((entry) => entry.event === "gh.poll_cycle")
    .map((entry) => entry.details ?? {});
}

describe("gh usage accounting", () => {
  beforeEach(() => {
    logSpurEventMock.mockReset();
    _resetGhUsageForTests();
    setGhEventSink("/tmp/spur-data");
  });

  afterEach(() => {
    _resetGhUsageForTests();
  });

  it("emits exactly one minute event per window with the per-subcommand breakdown", () => {
    noteGhInvocation(["api", "graphql", "-f", "query=..."], T0);
    noteGhInvocation(["api", "graphql", "-f", "query=..."], T0 + 1_000);
    noteGhInvocation(["pr", "view", "42"], T0 + 2_000);

    // Nothing emitted while the window is still open.
    expect(usageEvents("minute")).toHaveLength(0);

    // The first call past 60s flushes the closed window and opens a new one.
    noteGhInvocation(["pr", "checks"], T0 + MINUTE + 500);
    expect(usageEvents("minute")).toHaveLength(1);
    expect(usageEvents("minute")[0]).toMatchObject({
      window: "minute",
      calls: 3,
      bySubcommand: { "api graphql": 2, "pr view": 1 },
    });

    // Further calls inside the new window emit nothing more.
    noteGhInvocation(["pr", "checks"], T0 + MINUTE + 1_500);
    expect(usageEvents("minute")).toHaveLength(1);

    noteGhInvocation(["pr", "checks"], T0 + 2 * MINUTE + 600);
    expect(usageEvents("minute")).toHaveLength(2);
    expect(usageEvents("minute")[1]).toMatchObject({ calls: 2, bySubcommand: { "pr checks": 2 } });
  });

  it("emits nothing when no gh call happened", () => {
    noteGhInvocation(["api", "graphql"], T0);
    // No invocation for two full minutes: no timer, so no event.
    expect(logSpurEventMock).toHaveBeenCalledTimes(0);
  });

  it("rolls up one hour event per hour", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGhInvocation(["api", "graphql"], T0 + 30 * MINUTE);
    expect(usageEvents("hour")).toHaveLength(0);

    noteGhInvocation(["pr", "list"], T0 + HOUR + 1_000);
    expect(usageEvents("hour")).toHaveLength(1);
    expect(usageEvents("hour")[0]).toMatchObject({
      window: "hour",
      calls: 2,
      bySubcommand: { "api graphql": 2 },
    });

    noteGhInvocation(["pr", "list"], T0 + 2 * HOUR + 2_000);
    expect(usageEvents("hour")).toHaveLength(2);
    expect(usageEvents("hour")[1]).toMatchObject({ calls: 1, bySubcommand: { "pr list": 1 } });
  });

  it("never lets a REST path become a key, so api graphql keeps its own", () => {
    // What the review providers actually build: a unique path per PR per page.
    for (let index = 0; index < 25; index += 1) {
      noteGhInvocation(
        ["api", `repos/ashugaev/spur/pulls/${index}/reviews?page=1`, "--paginate"],
        T0 + index,
      );
    }
    noteGhInvocation(["search", "prs", "--json", "number"], T0 + 30);
    noteGhInvocation(["api", "graphql", "-f", "query=..."], T0 + 40);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    const bySubcommand = usageEvents("minute")[0]?.["bySubcommand"] as Record<string, number>;
    expect(bySubcommand).toEqual({ "api rest": 25, "search prs": 1, "api graphql": 1 });
  });

  it("keys a bare subcommand and an unknown command without inventing keys", () => {
    noteGhInvocation(["auth", "--help"], T0);
    noteGhInvocation(["--version"], T0 + 1);
    noteGhInvocation(["cmd", "sub0"], T0 + 2);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    expect(usageEvents("minute")[0]?.["bySubcommand"]).toEqual({ auth: 1, other: 2 });
  });

  it("reports graphql points, not just call counts", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGraphqlCost(3, T0);
    noteGhInvocation(["api", "graphql"], T0 + 1_000);
    noteGraphqlCost(3, T0 + 1_000);
    noteGhInvocation(["pr", "view", "42"], T0 + 2_000);

    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);
    expect(usageEvents("minute")[0]).toMatchObject({ calls: 3, graphqlCost: 6 });
    expect(usageEvents("hour")).toHaveLength(0);
  });

  it("emits the open windows when the budget pauses lookups", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGraphqlCost(3, T0);
    expect(usageEvents("hour")).toHaveLength(0);

    // The pause is exactly the moment the daemon may stop invoking gh, so the
    // window covering the exhaustion must not wait for a next invocation.
    recordGraphqlBudget(1, T0 + HOUR, T0 + 1_000);
    expect(pollBudgetState(T0 + 2_000)).toMatchObject({ blocked: true });

    expect(usageEvents("hour")).toHaveLength(1);
    expect(usageEvents("hour")[0]).toMatchObject({ calls: 1, graphqlCost: 3 });
    expect(usageEvents("minute")).toHaveLength(1);
  });

  it("emits nothing without an event sink", () => {
    _resetGhUsageForTests();
    noteGhInvocation(["api", "graphql"], T0);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);
    expect(logSpurEventMock).toHaveBeenCalledTimes(0);
  });

  it("emits one exact counter for each poll cycle, including a zero-call cycle", async () => {
    await runGhPollCycle({ kind: "attention" }, async () => {
      noteGhInvocation(["api", "graphql"], T0);
      noteGraphqlCost(3, T0);
      noteGhInvocation(["pr", "view", "42"], T0 + 1);
    });
    await runGhPollCycle({ kind: "github_source" }, async () => {});

    expect(cycleEvents()).toEqual([
      {
        cycle: "attention",
        durationMs: expect.any(Number),
        calls: 2,
        graphqlCost: 3,
        bySubcommand: { "api graphql": 1, "pr view": 1 },
      },
      {
        cycle: "github_source",
        durationMs: expect.any(Number),
        calls: 0,
        graphqlCost: 0,
        bySubcommand: {},
      },
    ]);
  });

  it("keeps concurrent cycle counters isolated and emits on failure", async () => {
    const first = runGhPollCycle({ kind: "attention" }, async () => {
      await Promise.resolve();
      noteGhInvocation(["api", "graphql"], T0);
    });
    const second = runGhPollCycle({ kind: "github_source" }, async () => {
      noteGhInvocation(["pr", "checks", "42"], T0);
      throw new Error("poll failed");
    });

    await first;
    await expect(second).rejects.toThrow("poll failed");
    expect(cycleEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cycle: "attention", calls: 1 }),
        expect.objectContaining({ cycle: "github_source", calls: 1 }),
      ]),
    );
  });
});

describe("graphql budget ledger", () => {
  beforeEach(() => {
    logSpurEventMock.mockReset();
    _resetGhUsageForTests();
    setGhEventSink("/tmp/spur-data");
  });

  afterEach(() => {
    _resetGhUsageForTests();
  });

  it("does not block with no observation", () => {
    expect(pollBudgetState(T0)).toEqual({ blocked: false });
  });

  it("blocks under the interactive floor and unblocks past resetAt", () => {
    recordGraphqlBudget(GH_POLL_MIN_GRAPHQL_REMAINING - 1, T0 + 10 * MINUTE, T0);

    expect(pollBudgetState(T0 + 1_000)).toEqual({
      blocked: true,
      reason: "remaining",
      remaining: GH_POLL_MIN_GRAPHQL_REMAINING - 1,
      resetAt: new Date(T0 + 10 * MINUTE).toISOString(),
    });
    // Only one paused event per block window.
    pollBudgetState(T0 + 2_000);
    expect(pausedEvents()).toHaveLength(1);
    expect(pausedEvents()[0]).toEqual({
      remaining: GH_POLL_MIN_GRAPHQL_REMAINING - 1,
      resetAt: new Date(T0 + 10 * MINUTE).toISOString(),
    });

    expect(pollBudgetState(T0 + 10 * MINUTE)).toEqual({ blocked: false });
  });

  it("does not block at the floor exactly", () => {
    recordGraphqlBudget(GH_POLL_MIN_GRAPHQL_REMAINING, T0 + HOUR, T0);
    expect(pollBudgetState(T0 + 1_000)).toEqual({ blocked: false });
  });

  it("doubles the reactive cooldown from 5min to a 60min cap", () => {
    const expected = [5, 10, 20, 40, 60, 60].map((minutes) => minutes * MINUTE);
    for (const backoff of expected) {
      noteGitHubRateLimitHit(T0);
      expect(pollBudgetState(T0 + backoff - 1)).toMatchObject({
        blocked: true,
        reason: "cooldown",
      });
      expect(pollBudgetState(T0 + backoff)).toEqual({ blocked: false });
    }
  });

  it("keeps a cooldown that was opened after the last observation's resetAt", () => {
    // Healthy reading whose window closes in 55min.
    recordGraphqlBudget(4_800, T0 + 55 * MINUTE, T0);
    // A review-provider call hits the limit 1min after that window closed.
    noteGitHubRateLimitHit(T0 + 56 * MINUTE);

    // Rolling the stale observation over must not discard the fresh cooldown.
    expect(pollBudgetState(T0 + 60 * MINUTE)).toMatchObject({
      blocked: true,
      reason: "cooldown",
    });
    expect(pollBudgetState(T0 + 61 * MINUTE + 1)).toEqual({ blocked: false });
  });

  it("expires an observation that carried no resetAt instead of pausing forever", () => {
    // GitHub Enterprise and malformed payloads produce a null resetAt.
    recordGraphqlBudget(10, null, T0);

    expect(pollBudgetState(T0 + MINUTE)).toMatchObject({ blocked: true, reason: "remaining" });
    // One budget window later the reading is meaningless and must be dropped,
    // even though only the poll path could ever refresh it.
    expect(pollBudgetState(T0 + 60 * MINUTE)).toEqual({ blocked: false });
  });

  it("clears the reactive cooldown on a healthy observation", () => {
    noteGitHubRateLimitHit(T0);
    expect(pollBudgetState(T0 + 1_000)).toMatchObject({ blocked: true, reason: "cooldown" });

    recordGraphqlBudget(4_800, T0 + HOUR, T0 + 2_000);
    expect(pollBudgetState(T0 + 3_000)).toEqual({ blocked: false });

    // hits reset, so the next block starts at the 5min base again.
    noteGitHubRateLimitHit(T0 + 4_000);
    expect(pollBudgetState(T0 + 4_000 + 5 * MINUTE)).toEqual({ blocked: false });
  });
});
