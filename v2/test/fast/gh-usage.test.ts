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
  pollBudgetState,
  recordGraphqlBudget,
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

  it("folds subcommand keys past the cap into other", () => {
    for (let index = 0; index < 25; index += 1) {
      noteGhInvocation(["cmd", `sub${index}`], T0 + index);
    }
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    const details = usageEvents("minute")[0];
    const bySubcommand = details?.["bySubcommand"] as Record<string, number>;
    // 19 distinct keys plus the reserved "other" slot.
    expect(Object.keys(bySubcommand)).toHaveLength(20);
    expect(bySubcommand["cmd sub0"]).toBe(1);
    expect(bySubcommand["cmd sub18"]).toBe(1);
    expect(bySubcommand["cmd sub19"]).toBeUndefined();
    // 25 calls minus the 19 keys kept before the cap is reached.
    expect(bySubcommand["other"]).toBe(6);
  });

  it("keys a bare subcommand and a flag-only argv without a second token", () => {
    noteGhInvocation(["auth", "--help"], T0);
    noteGhInvocation(["--version"], T0 + 1);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    expect(usageEvents("minute")[0]?.["bySubcommand"]).toEqual({ auth: 1, other: 1 });
  });

  it("emits nothing without an event sink", () => {
    _resetGhUsageForTests();
    noteGhInvocation(["api", "graphql"], T0);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);
    expect(logSpurEventMock).toHaveBeenCalledTimes(0);
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
    for (const [index, backoff] of expected.entries()) {
      noteGitHubRateLimitHit(T0);
      const state = pollBudgetState(T0 + backoff - 1);
      expect(state).toMatchObject({ blocked: true, reason: "cooldown" });
      expect(pollBudgetState(T0 + backoff)).toEqual({ blocked: false });
      expect(index).toBeGreaterThanOrEqual(0);
    }
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
