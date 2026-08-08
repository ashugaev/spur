// Pure sidecar-reap policy: owner-state plus idle-TTL, with an
// established-TCP-connection veto that outranks every reap reason. Zero IO,
// no session-service.js import (mirrors reap.ts's own rule) — every input is
// pre-resolved by the caller so this stays testable with no daemon, no tmux,
// no ps. See session-gc.ts's planSessionGc/executeSessionGc split for the
// precedent this mirrors.
//
// Decision table (first match wins; this ordering IS the specification):
//   1  config.enabled === false                          -> keep  disabled
//   2  mcp === true                                       -> keep  mcp
//   3  !paneAlive && !hasRecordedIdentity                 -> keep  no_pane_no_identity
//   4  connections === "established"                      -> keep  connections_established
//   5  connections === "unknown"                           -> keep  probe_unknown
//   6  !ownerExists                                       -> reap  owner_missing
//   7  !worktreeExists                                    -> reap  worktree_missing
//   8  !workspaceRunning                                  -> reap  workspace_not_running
//   9  lastActivityAtMs === null                          -> keep  activity_unknown
//  10  nowMs - lastActivityAtMs >= idleTtlMinutes*60000    -> reap  idle_ttl
//  11  otherwise                                          -> keep  within_idle_ttl
// Steps 4-5 sit above every reap step (6-10): no probe outcome other than a
// clean zero-row read can ever reach a reap verdict — a probe failure or
// timeout can never authorize a kill.
// Orthogonal to the table above: any candidate NOT in `reap` whose age is
// past `maxAgeWarnMinutes` is also emitted in `warn` (reason age_cap).
// `warn` never kills — it is visibility only.

export interface SidecarReapCandidate {
  /** sidecarOwnerIdForName result: the record that owns this pane/identity. */
  ownerId: string;
  sidecarName: string;
  /** sidecarTmuxSession(ownerId, sidecarName), built by the caller. */
  tmuxName: string;
  paneAlive: boolean;
  mcp: boolean;
  ownerExists: boolean;
  worktreeExists: boolean;
  /** hasRunningWorkspaceMembers(owner) semantics, including the owner itself. */
  workspaceRunning: boolean;
  hasRecordedIdentity: boolean;
  /** Max lastActivityAt over workspace members; null when unknown. */
  lastActivityAtMs: number | null;
  /** Per-sidecar override already resolved by the caller. */
  idleTtlMinutes: number;
  connections: "established" | "none" | "unknown";
  ageSeconds: number | null;
}

export interface SidecarReapConfig {
  enabled: boolean;
  idleTtlMinutes: number;
  maxAgeWarnMinutes: number;
}

export interface SidecarReapInput {
  nowMs: number;
  config: SidecarReapConfig;
  candidates: readonly SidecarReapCandidate[];
}

export type SidecarReapReason =
  | "owner_missing"
  | "worktree_missing"
  | "workspace_not_running"
  | "idle_ttl";

export type SidecarKeepReason =
  | "disabled"
  | "mcp"
  | "no_pane_no_identity"
  | "connections_established"
  | "probe_unknown"
  | "activity_unknown"
  | "within_idle_ttl";

export type SidecarWarnReason = "age_cap";

export interface SidecarReapEntry {
  ownerId: string;
  sidecarName: string;
  tmuxName: string;
  reason: SidecarReapReason;
}

export interface SidecarKeepEntry {
  ownerId: string;
  sidecarName: string;
  tmuxName: string;
  reason: SidecarKeepReason;
}

export interface SidecarWarnEntry {
  ownerId: string;
  sidecarName: string;
  tmuxName: string;
  reason: SidecarWarnReason;
}

export interface SidecarReapPlan {
  reap: SidecarReapEntry[];
  warn: SidecarWarnEntry[];
  keep: SidecarKeepEntry[];
}

function base(candidate: SidecarReapCandidate): {
  ownerId: string;
  sidecarName: string;
  tmuxName: string;
} {
  return {
    ownerId: candidate.ownerId,
    sidecarName: candidate.sidecarName,
    tmuxName: candidate.tmuxName,
  };
}

/**
 * Optional per-sidecar `idleTtlMinutes` override wins over the sidecarGc
 * default; undefined/absent falls through to the config default.
 */
export function resolveSidecarIdleTtlMinutes(
  sidecarOverride: number | undefined,
  configDefault: number,
): number {
  return sidecarOverride ?? configDefault;
}

function decide(
  candidate: SidecarReapCandidate,
  config: SidecarReapConfig,
  nowMs: number,
): { verdict: "reap"; reason: SidecarReapReason } | { verdict: "keep"; reason: SidecarKeepReason } {
  if (!config.enabled) {
    return { verdict: "keep", reason: "disabled" };
  }
  if (candidate.mcp) {
    return { verdict: "keep", reason: "mcp" };
  }
  if (!candidate.paneAlive && !candidate.hasRecordedIdentity) {
    return { verdict: "keep", reason: "no_pane_no_identity" };
  }
  if (candidate.connections === "established") {
    return { verdict: "keep", reason: "connections_established" };
  }
  if (candidate.connections === "unknown") {
    return { verdict: "keep", reason: "probe_unknown" };
  }
  if (!candidate.ownerExists) {
    return { verdict: "reap", reason: "owner_missing" };
  }
  if (!candidate.worktreeExists) {
    return { verdict: "reap", reason: "worktree_missing" };
  }
  if (!candidate.workspaceRunning) {
    return { verdict: "reap", reason: "workspace_not_running" };
  }
  if (candidate.lastActivityAtMs === null) {
    return { verdict: "keep", reason: "activity_unknown" };
  }
  const idleMs = nowMs - candidate.lastActivityAtMs;
  if (idleMs >= candidate.idleTtlMinutes * 60_000) {
    return { verdict: "reap", reason: "idle_ttl" };
  }
  return { verdict: "keep", reason: "within_idle_ttl" };
}

export function planSidecarReap(input: SidecarReapInput): SidecarReapPlan {
  const plan: SidecarReapPlan = { reap: [], warn: [], keep: [] };
  for (const candidate of input.candidates) {
    const outcome = decide(candidate, input.config, input.nowMs);
    if (outcome.verdict === "reap") {
      plan.reap.push({ ...base(candidate), reason: outcome.reason });
    } else {
      plan.keep.push({ ...base(candidate), reason: outcome.reason });
    }
    // Orthogonal to the reap/keep verdict: a candidate not already reaped
    // whose recorded age is past the warn threshold gets flagged for
    // visibility. Warn never kills, so it's evaluated independent of the
    // verdict above and only skipped when the verdict was already "reap".
    if (
      outcome.verdict !== "reap" &&
      candidate.ageSeconds !== null &&
      candidate.ageSeconds >= input.config.maxAgeWarnMinutes * 60
    ) {
      plan.warn.push({ ...base(candidate), reason: "age_cap" });
    }
  }
  return plan;
}
