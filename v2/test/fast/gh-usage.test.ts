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
  flushGhPollCycles,
  noteGhInvocation,
  noteGitHubRateLimitHit,
  noteGraphqlCost,
  pollBudgetState,
  recordGraphqlBudget,
  recordGraphqlBudgetFromEnvelope,
  runGhPollCycle,
  setGhEventSink,
  withGhPollBudget,
} = await import("../../src/gh.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000;
// Mirrors gh.ts's GH_POLL_CYCLE_ROLLUP_MS. Not exported: the rollup window is
// a source constant, not a public knob, so tests pin the value instead.
const GH_POLL_CYCLE_ROLLUP_MS = 900_000;

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
    noteGraphqlCost(0, T0);
    noteGhInvocation(["api", "graphql", "-f", "query=..."], T0 + 1_000);
    noteGraphqlCost(0, T0 + 1_000);
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
    noteGraphqlCost(0, T0);
    noteGhInvocation(["api", "graphql"], T0 + 30 * MINUTE);
    noteGraphqlCost(0, T0 + 30 * MINUTE);
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
    noteGraphqlCost(0, T0 + 40);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    const bySubcommand = usageEvents("minute")[0]?.["bySubcommand"] as Record<string, number>;
    expect(bySubcommand).toEqual({ "api rest": 25, "search prs": 1, "api graphql": 1 });
  });

  it("classifies hostname-qualified GraphQL calls separately from REST", () => {
    noteGhInvocation(["api", "--hostname", "github.corp.example", "graphql"], T0);
    noteGraphqlCost(0, T0);
    noteGhInvocation(["api", "--hostname", "github.corp.example", "repos/o/r"], T0 + 1);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    expect(usageEvents("minute")[0]?.["bySubcommand"]).toEqual({
      "api graphql": 1,
      "api rest": 1,
    });
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

  it("attributes concurrent rollover responses to their invocation windows", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);

    noteGraphqlCost(2, T0 + MINUTE + 1);
    expect(usageEvents("minute")).toHaveLength(0);

    noteGraphqlCost(3, T0);
    expect(usageEvents("minute")[0]).toMatchObject({ calls: 1, graphqlCost: 3 });

    noteGhInvocation(["pr", "view", "42"], T0 + 2 * MINUTE + 2);
    expect(usageEvents("minute")[1]).toMatchObject({ calls: 1, graphqlCost: 2 });
  });

  it("closes a pending usage window after a malformed GraphQL response", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGhInvocation(["pr", "view", "42"], T0 + MINUTE + 1);
    expect(usageEvents("minute")).toHaveLength(0);

    recordGraphqlBudgetFromEnvelope(null, T0);

    expect(usageEvents("minute")[0]).toMatchObject({ calls: 1, graphqlCost: 0 });
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

  it("does not duplicate usage windows across distinct budget pauses", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGraphqlCost(3, T0);
    recordGraphqlBudget(900, T0 + HOUR, T0 + 1_000);
    pollBudgetState(T0 + 2_000);

    noteGhInvocation(["api", "graphql"], T0 + 3_000);
    noteGraphqlCost(2, T0 + 3_000);
    recordGraphqlBudget(800, T0 + 2 * HOUR, T0 + 4_000);
    pollBudgetState(T0 + 5_000);

    expect(usageEvents("minute")).toHaveLength(1);
    expect(usageEvents("hour")).toHaveLength(1);
    expect(usageEvents("minute")[0]).toMatchObject({ calls: 1, graphqlCost: 3 });
    expect(usageEvents("hour")[0]).toMatchObject({ calls: 1, graphqlCost: 3 });

    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 4_000);
    expect(usageEvents("minute")).toHaveLength(2);
    expect(usageEvents("minute")[1]).toMatchObject({ calls: 1, graphqlCost: 2 });
  });

  it("spaces early-pause emissions from the prior emission and keeps later counters", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGraphqlCost(3, T0);
    recordGraphqlBudget(900, T0 + HOUR, T0 + 500);
    pollBudgetState(T0 + 1_000);

    noteGhInvocation(["api", "graphql"], T0 + 2_000);
    noteGraphqlCost(2, T0 + 2_000);
    noteGhInvocation(["pr", "view", "42"], T0 + 60_500);
    recordGraphqlBudget(800, T0 + 2 * HOUR, T0 + 59_500);
    pollBudgetState(T0 + 60_000);

    expect(usageEvents("minute")).toHaveLength(1);
    expect(usageEvents("hour")).toHaveLength(1);

    recordGraphqlBudget(700, T0 + 3 * HOUR, T0 + 60_500);
    pollBudgetState(T0 + 61_000);
    recordGraphqlBudget(600, T0 + 4 * HOUR, T0 + HOUR + 500);
    pollBudgetState(T0 + HOUR + 1_000);

    const minutes = usageEvents("minute");
    const hours = usageEvents("hour");
    expect(minutes[1]).toMatchObject({
      calls: 2,
      graphqlCost: 2,
      bySubcommand: { "api graphql": 1, "pr view": 1 },
    });
    expect(hours[1]).toMatchObject({
      calls: 2,
      graphqlCost: 2,
      bySubcommand: { "api graphql": 1, "pr view": 1 },
    });
    const minuteEmissionGap =
      T0 + 2_000 + Number(minutes[1]?.["windowMs"]) - (T0 + Number(minutes[0]?.["windowMs"]));
    const hourEmissionGap =
      T0 + 2_000 + Number(hours[1]?.["windowMs"]) - (T0 + Number(hours[0]?.["windowMs"]));
    expect(minuteEmissionGap).toBeGreaterThanOrEqual(MINUTE);
    expect(hourEmissionGap).toBeGreaterThanOrEqual(HOUR);
  });

  it("emits delayed closed windows in invocation order", () => {
    noteGhInvocation(["api", "graphql"], T0);
    noteGhInvocation(["api", "graphql"], T0 + MINUTE + 1);
    noteGraphqlCost(2, T0 + MINUTE + 1, T0 + MINUTE + 2);
    noteGhInvocation(["pr", "view", "42"], T0 + 2 * MINUTE + 2);

    expect(usageEvents("minute")).toHaveLength(0);

    noteGraphqlCost(3, T0, T0 + 2 * MINUTE + 3);
    expect(usageEvents("minute")).toEqual([expect.objectContaining({ calls: 1, graphqlCost: 3 })]);

    noteGhInvocation(["pr", "checks", "42"], T0 + 3 * MINUTE + 3);
    expect(usageEvents("minute").slice(0, 2)).toEqual([
      expect.objectContaining({ calls: 1, graphqlCost: 3 }),
      expect.objectContaining({ calls: 1, graphqlCost: 2 }),
    ]);
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

  it("collapses a run of zero-cost cycles into one event", async () => {
    for (let index = 0; index < 5; index += 1) {
      await runGhPollCycle({ kind: "attention" }, async () => {});
    }

    expect(cycleEvents()).toEqual([
      {
        cycle: "attention",
        durationMs: expect.any(Number),
        calls: 0,
        graphqlCost: 0,
        bySubcommand: {},
      },
    ]);
  });

  it("reports the swallowed zero cycles on the next paying cycle and reopens the run", async () => {
    // Rollup: the paying 4th cycle now lands inside the window opened by the
    // first (zero-cost) cycle, so it accumulates instead of emitting on the
    // spot. Only the window's own close, past GH_POLL_CYCLE_ROLLUP_MS, emits
    // the aggregate — with cycles/zeroCycles, not suppressedZeroCycles.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      await runGhPollCycle({ kind: "attention" }, async () => {});
      await runGhPollCycle({ kind: "attention" }, async () => {});
      await runGhPollCycle({ kind: "attention" }, async () => {});
      await runGhPollCycle({ kind: "attention" }, async () => {
        noteGhInvocation(["pr", "view", "42"], Date.now());
      });
      await runGhPollCycle({ kind: "attention" }, async () => {});
      await runGhPollCycle({ kind: "attention" }, async () => {});

      expect(cycleEvents()).toEqual([expect.objectContaining({ calls: 0, bySubcommand: {} })]);

      vi.setSystemTime(T0 + GH_POLL_CYCLE_ROLLUP_MS);
      await runGhPollCycle({ kind: "attention" }, async () => {});

      expect(cycleEvents()).toEqual([
        expect.objectContaining({ calls: 0, bySubcommand: {} }),
        expect.objectContaining({ calls: 1, cycles: 6, zeroCycles: 5 }),
      ]);
      expect(cycleEvents()[1]).not.toHaveProperty("suppressedZeroCycles");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ages out a zero-cycle run whose source stopped polling", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "a" },
        async () => {},
      );
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "a" },
        async () => {},
      );

      // The source goes quiet for longer than the idle ceiling, then returns.
      vi.setSystemTime(T0 + HOUR + MINUTE);
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "a" },
        async () => {},
      );

      expect(cycleEvents()).toHaveLength(2);
      expect(cycleEvents()[1]).not.toHaveProperty("suppressedZeroCycles");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks zero-cycle runs per kind and per source", async () => {
    await runGhPollCycle({ kind: "attention" }, async () => {});
    await runGhPollCycle({ kind: "attention" }, async () => {});
    await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {});
    await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {});
    await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "b" }, async () => {});

    const emitted = logSpurEventMock.mock.calls
      .map((call) => call[1] as { event: string; sourceId?: string; details?: { cycle?: string } })
      .filter((entry) => entry.event === "gh.poll_cycle")
      .map((entry) => `${entry.details?.cycle}:${entry.sourceId ?? ""}`);

    expect(emitted).toEqual(["attention:", "github_source:a", "github_source:b"]);
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

  // AC1 regression pin: emission stays one event per completed cycle no
  // matter how many sessions it polled. Already true pre-rollup (session
  // count only moves cycle.calls), so this passes on a full revert by
  // design — excluded from the mutation check.
  it("emits exactly one event per cycle regardless of session count", async () => {
    await runGhPollCycle({ kind: "attention" }, async () => {
      for (let index = 0; index < 90; index += 1) {
        noteGhInvocation(["pr", "view", String(index)], T0);
      }
    });

    expect(cycleEvents()).toHaveLength(1);
    expect(cycleEvents()[0]).toMatchObject({ calls: 90 });
  });

  it("AC2: rolls up M paying cycles inside the window into one aggregate at the next boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "1"], Date.now());
      });
      for (let index = 0; index < 4; index += 1) {
        await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
          noteGhInvocation(["pr", "view", "2"], Date.now());
        });
      }
      expect(cycleEvents()).toHaveLength(1);

      vi.setSystemTime(T0 + GH_POLL_CYCLE_ROLLUP_MS);
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "3"], Date.now());
      });

      expect(cycleEvents()).toHaveLength(2);
      expect(cycleEvents()[1]).toMatchObject({
        cycles: 5,
        calls: 5,
        bySubcommand: { "pr view": 5 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC3: keeps per-key rollups isolated under M paying cycles on two keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "1"], Date.now());
      });
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "b" }, async () => {
        noteGhInvocation(["pr", "view", "1"], Date.now());
      });
      expect(cycleEvents()).toHaveLength(2);

      for (let index = 0; index < 3; index += 1) {
        await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
          noteGhInvocation(["pr", "view", "2"], Date.now());
        });
        await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "b" }, async () => {
          noteGhInvocation(["pr", "list"], Date.now());
          noteGhInvocation(["pr", "list"], Date.now());
        });
      }
      expect(cycleEvents()).toHaveLength(2);

      vi.setSystemTime(T0 + GH_POLL_CYCLE_ROLLUP_MS);
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "3"], Date.now());
      });
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "b" }, async () => {
        noteGhInvocation(["pr", "list"], Date.now());
      });

      expect(cycleEvents()).toHaveLength(4);
      expect(cycleEvents()[2]).toMatchObject({ cycles: 4, calls: 4 });
      expect(cycleEvents()[3]).toMatchObject({ cycles: 4, calls: 7 });
      const emittedKeys = logSpurEventMock.mock.calls
        .map((call) => call[1] as { event: string; sourceId?: string })
        .filter((entry) => entry.event === "gh.poll_cycle")
        .map((entry) => entry.sourceId);
      expect(emittedKeys).toEqual(["a", "b", "a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC7: flushes an open paying window at the idle prune instead of dropping it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "stale" },
        async () => {
          noteGhInvocation(["pr", "view", "1"], Date.now());
        },
      );
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "stale" },
        async () => {
          noteGhInvocation(["pr", "view", "2"], Date.now());
        },
      );
      expect(cycleEvents()).toHaveLength(1);

      // The stale source's config entry is gone: nothing polls it again.
      // A different key's cycle, run more than the idle ceiling later,
      // is what drives the prune scan that discovers it.
      vi.setSystemTime(T0 + HOUR + MINUTE);
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "other" },
        async () => {},
      );

      const emitted = logSpurEventMock.mock.calls
        .map((call) => call[1] as { event: string; sourceId?: string; details?: unknown })
        .filter((entry) => entry.event === "gh.poll_cycle" && entry.sourceId === "stale");
      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.details).toMatchObject({ cycles: 1, calls: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC8: caps gh.poll_cycle volume at the measured host shape over one hour of virtual time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      const sourceIds = ["gh", "diary-bot", "int", "assistant", "int-review"];
      for (let tick = 0; tick < 60; tick += 1) {
        for (const sourceId of sourceIds) {
          await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId }, async () => {
            noteGhInvocation(["pr", "list"], Date.now());
          });
        }
        vi.setSystemTime(T0 + (tick + 1) * MINUTE);
      }

      expect(cycleEvents().length).toBeLessThanOrEqual(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC10: an idle host stays at one event per key across 2h of zero-cost cycles", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      const sourceIds = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
      for (let tick = 0; tick < 60; tick += 1) {
        for (const sourceId of sourceIds) {
          await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId }, async () => {});
        }
        vi.setSystemTime(T0 + (tick + 1) * 2 * MINUTE);
      }

      expect(cycleEvents()).toHaveLength(sourceIds.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC11: a paying window already flushed by expiry is never re-emitted at shutdown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "1"], Date.now());
      });
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "2"], Date.now());
      });

      vi.setSystemTime(T0 + GH_POLL_CYCLE_ROLLUP_MS);
      await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "a" }, async () => {
        noteGhInvocation(["pr", "view", "3"], Date.now());
      });
      expect(cycleEvents()).toHaveLength(2);

      flushGhPollCycles();
      expect(cycleEvents()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts folded failures and still emits one aggregate for an errors-only window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      // First cycle for a brand-new key fails outright: emits immediately as
      // its own standalone event, carrying its own errors:1, and opens a run
      // with clean counters. This cycle was never counted as one of the
      // run's cycles, so its own failure must not be seeded into the run —
      // that would attribute a failure to a window that never actually
      // folded this cycle into it. The standalone event is the only window
      // this cycle belongs to, so it reports the failure itself.
      await expect(
        runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "dead" }, async () => {
          throw new Error("gh unavailable");
        }),
      ).rejects.toThrow("gh unavailable");
      expect(cycleEvents()).toHaveLength(1);
      expect(cycleEvents()[0]).toMatchObject({ errors: 1 });

      // Three more failing, zero-cost cycles fold silently into the window.
      for (let index = 0; index < 3; index += 1) {
        await expect(
          runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "dead" }, async () => {
            throw new Error("gh unavailable");
          }),
        ).rejects.toThrow("gh unavailable");
      }
      expect(cycleEvents()).toHaveLength(1);

      // A non-failing, still zero-cost cycle past the window closes it. The
      // window spent nothing in calls/graphqlCost, but it must still emit
      // because it counted 3 errors from the 3 folded failing cycles — a
      // dead source may never pay, but it must still surface.
      vi.setSystemTime(T0 + GH_POLL_CYCLE_ROLLUP_MS);
      await runGhPollCycle(
        { kind: "github_source", projectId: "p", sourceId: "dead" },
        async () => {},
      );

      expect(cycleEvents()).toHaveLength(2);
      expect(cycleEvents()[1]).toMatchObject({
        cycles: 4,
        zeroCycles: 4,
        calls: 0,
        graphqlCost: 0,
        errors: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens no run and never emits an aggregate for a key polled before any sink is set", async () => {
    // Mirrors a CLI process, which never calls setGhEventSink: the first
    // cycle for a key still runs (and a failure still propagates to the
    // caller), but nothing is tracked, so the pollCycleRuns map never grows
    // and no run's windowStartedAtMs clock starts ticking on a cycle nobody
    // could ever log.
    setGhEventSink(null);
    await expect(
      runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "cli" }, async () => {
        throw new Error("gh unavailable");
      }),
    ).rejects.toThrow("gh unavailable");
    await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "cli" }, async () => {
      noteGhInvocation(["pr", "view", "1"], Date.now());
    });
    expect(cycleEvents()).toHaveLength(0);

    // Setting a sink afterward opens a clean run on the next cycle for that
    // key rather than resuming a phantom window that started ticking earlier.
    setGhEventSink("/tmp/spur-data");
    await runGhPollCycle({ kind: "github_source", projectId: "p", sourceId: "cli" }, async () => {
      noteGhInvocation(["pr", "view", "2"], Date.now());
    });
    expect(cycleEvents()).toHaveLength(1);
    expect(cycleEvents()[0]).toMatchObject({ calls: 1 });
  });

  it("accounts GraphQL cost from an error envelope", async () => {
    await runGhPollCycle({ kind: "github_source" }, async () => {
      noteGhInvocation(["api", "graphql"], T0);
      recordGraphqlBudgetFromEnvelope(
        {
          data: {
            rateLimit: { cost: 7, remaining: 900, resetAt: new Date(T0 + HOUR).toISOString() },
          },
          errors: [{ message: "query failed" }],
        },
        T0,
      );
    });

    expect(cycleEvents()[0]).toMatchObject({ calls: 1, graphqlCost: 7 });
    expect(pollBudgetState(T0 + 1)).toMatchObject({ blocked: true, remaining: 900 });
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

  it("does not raise remaining from stale or same-window observations", () => {
    recordGraphqlBudget(900, T0 + HOUR, T0 + 2_000);
    recordGraphqlBudget(4_800, T0 + HOUR, T0 + 3_000);
    recordGraphqlBudget(4_900, T0 + 2 * HOUR, T0 + 1_000);

    expect(pollBudgetState(T0 + 4_000)).toMatchObject({ blocked: true, remaining: 900 });
  });

  it("serializes poll admission and blocks the next task after budget depletion", async () => {
    let release = (): void => {};
    let started = false;
    const first = withGhPollBudget(
      () =>
        new Promise<void>((resolve) => {
          started = true;
          release = () => {
            recordGraphqlBudget(900, T0 + HOUR, T0 + 1_000);
            resolve();
          };
        }),
    );
    const secondTask = vi.fn(async () => {});
    const second = withGhPollBudget(secondTask);

    await vi.waitFor(() => expect(started).toBe(true));
    expect(secondTask).not.toHaveBeenCalled();
    release();

    await expect(first).resolves.toMatchObject({ status: "admitted" });
    await expect(second).resolves.toMatchObject({ status: "blocked" });
    expect(secondTask).not.toHaveBeenCalled();
  });
});
