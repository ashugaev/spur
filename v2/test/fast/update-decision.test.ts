import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECISION_CONFIG,
  evaluate,
  initialDecisionState,
  type DecisionConfig,
  type DecisionState,
} from "../../src/update-decision.js";
import type {
  PollSample,
  ProbeResult,
  ServiceId,
  UnitState,
} from "../../src/update-health.js";

const OK: ProbeResult = { ok: true };
const REFUSED: ProbeResult = { ok: false, reason: "connection-refused" };
const HTTP_ERROR: ProbeResult = { ok: false, reason: "http-error" };

const cfg: DecisionConfig = DEFAULT_DECISION_CONFIG;

function sample(
  atMs: number,
  overrides: {
    health?: Partial<Record<ServiceId, ProbeResult>>;
    units?: Partial<Record<ServiceId, UnitState>>;
  } = {},
): PollSample {
  return {
    atMs,
    health: {
      daemon: overrides.health?.daemon ?? OK,
      web: overrides.health?.web ?? OK,
      terminal: overrides.health?.terminal ?? OK,
    },
    units: {
      daemon: overrides.units?.daemon ?? "active",
      web: overrides.units?.web ?? "active",
      terminal: overrides.units?.terminal ?? "active",
    },
  };
}

function fold(samples: PollSample[], config: DecisionConfig = cfg): DecisionState {
  let state = initialDecisionState(0);
  for (const s of samples) {
    state = evaluate(state, s, config).next;
  }
  return state;
}

describe("update-decision", () => {
  it("never commits or rolls back during warmup", () => {
    // Warmup is 9000ms; even a failed unit within warmup only accrues counters.
    expect(evaluate(initialDecisionState(0), sample(3000), cfg).decision).toEqual({
      kind: "continue",
    });
    expect(
      evaluate(initialDecisionState(0), sample(6000, { units: { daemon: "failed" } }), cfg).decision,
    ).toEqual({ kind: "continue" });
  });

  it("commits after K consecutive healthy samples past warmup", () => {
    let state = initialDecisionState(0);
    const decisions = [12000, 15000, 18000].map((atMs) => {
      const result = evaluate(state, sample(atMs), cfg);
      state = result.next;
      return result.decision;
    });
    expect(decisions[0]).toEqual({ kind: "continue" });
    expect(decisions[1]).toEqual({ kind: "continue" });
    expect(decisions[2]).toEqual({ kind: "commit" });
  });

  it("resets the healthy streak on a single failed probe without rolling back", () => {
    const primed = fold([sample(12000), sample(15000)]);
    expect(primed.consecutiveHealthy).toBe(2);
    const result = evaluate(primed, sample(18000, { health: { web: HTTP_ERROR } }), cfg);
    expect(result.decision).toEqual({ kind: "continue" });
    expect(result.next.consecutiveHealthy).toBe(0);
  });

  it("rolls back at the deadline when a unit is failed", () => {
    const result = evaluate(
      initialDecisionState(0),
      sample(cfg.deadlineMs, { health: { daemon: HTTP_ERROR }, units: { daemon: "failed" } }),
      cfg,
    );
    expect(result.decision.kind).toBe("rollback");
    if (result.decision.kind !== "rollback") throw new Error("unreachable");
    expect(result.decision.reason).toContain("failed");
  });

  it("rolls back at the deadline when connection refused reaches the threshold", () => {
    const prev: DecisionState = { startMs: 0, consecutiveHealthy: 0, consecutiveRefused: 2 };
    const result = evaluate(
      prev,
      sample(cfg.deadlineMs, { health: { daemon: REFUSED } }),
      cfg,
    );
    expect(result.next.consecutiveRefused).toBe(3);
    expect(result.decision.kind).toBe("rollback");
    if (result.decision.kind !== "rollback") throw new Error("unreachable");
    expect(result.decision.reason).toContain("refused");
  });

  it("abandons at the deadline when no hard failure is present", () => {
    const result = evaluate(
      initialDecisionState(0),
      sample(cfg.deadlineMs, { health: { web: HTTP_ERROR } }),
      cfg,
    );
    expect(result.decision).toEqual({ kind: "abandon" });
  });

  it("treats a unit still activating past warmup as a hard failure at the deadline", () => {
    const result = evaluate(
      initialDecisionState(0),
      sample(cfg.deadlineMs, { health: { web: HTTP_ERROR }, units: { web: "activating" } }),
      cfg,
    );
    expect(result.decision.kind).toBe("rollback");
    if (result.decision.kind !== "rollback") throw new Error("unreachable");
    expect(result.decision.reason).toContain("activating");
  });
});
