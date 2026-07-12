import type { ProbeResult, PollSample } from "./update-health.js";

export type Decision =
  | { kind: "continue" }
  | { kind: "commit" }
  | { kind: "abandon" }
  | { kind: "rollback"; reason: string };

export interface DecisionState {
  startMs: number;
  consecutiveHealthy: number;
  consecutiveRefused: number;
}

export interface DecisionConfig {
  warmupMs: number;
  pollMs: number;
  stableK: number;
  deadlineMs: number;
  refusedN: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  warmupMs: 9_000,
  pollMs: 3_000,
  stableK: 3,
  deadlineMs: 120_000,
  refusedN: 3,
};

export function initialDecisionState(startMs: number): DecisionState {
  return { startMs, consecutiveHealthy: 0, consecutiveRefused: 0 };
}

function allHealthy(sample: PollSample): boolean {
  return (["daemon", "web", "terminal"] as const).every((id) => sample.health[id].ok);
}

function refusedThisSample(sample: PollSample): boolean {
  return (["daemon", "web", "terminal"] as const).some((id): boolean =>
    probeRefused(sample.health[id]),
  );
}

function probeRefused(probe: ProbeResult): boolean {
  return probe.ok === false && probe.reason === "connection-refused";
}

function anyUnitFailed(sample: PollSample): boolean {
  return (["daemon", "web", "terminal"] as const).some((id) => sample.units[id] === "failed");
}

function anyUnitActivating(sample: PollSample): boolean {
  return (["daemon", "web", "terminal"] as const).some((id) => sample.units[id] === "activating");
}

export interface EvaluateResult {
  decision: Decision;
  next: DecisionState;
}

// Pure stabilize-or-deadline machine. No I/O. Given the prior counters and one
// fresh sample, decide whether to keep monitoring, commit the update, abandon
// it (deadline reached with no hard failure), or roll back.
export function evaluate(
  prev: DecisionState,
  sample: PollSample,
  cfg: DecisionConfig,
): EvaluateResult {
  const elapsed = sample.atMs - prev.startMs;
  const inWarmup = elapsed < cfg.warmupMs;

  const healthy = allHealthy(sample);
  const consecutiveHealthy = healthy ? prev.consecutiveHealthy + 1 : 0;
  const consecutiveRefused = refusedThisSample(sample) ? prev.consecutiveRefused + 1 : 0;
  const next: DecisionState = {
    startMs: prev.startMs,
    consecutiveHealthy,
    consecutiveRefused,
  };

  // During warmup services may still be booting; only accumulate counters.
  if (inWarmup) {
    return { decision: { kind: "continue" }, next };
  }

  if (consecutiveHealthy >= cfg.stableK) {
    return { decision: { kind: "commit" }, next };
  }

  // Rollback and abandon are resolved only once the stabilization deadline
  // passes: give the new version the full window to reach a healthy streak,
  // then decide based on whether a hard failure is present.
  if (elapsed >= cfg.deadlineMs) {
    const hardFailure =
      anyUnitFailed(sample) || anyUnitActivating(sample) || consecutiveRefused >= cfg.refusedN;
    if (hardFailure) {
      const reason = anyUnitFailed(sample)
        ? "a systemd unit entered the failed state"
        : anyUnitActivating(sample)
          ? "a systemd unit is still activating past warmup"
          : `connection refused on ${consecutiveRefused} consecutive polls`;
      return { decision: { kind: "rollback", reason }, next };
    }
    return { decision: { kind: "abandon" }, next };
  }

  return { decision: { kind: "continue" }, next };
}
