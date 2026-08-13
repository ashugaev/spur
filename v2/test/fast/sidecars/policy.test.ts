import { describe, expect, it } from "vitest";
import {
  planSidecarReap,
  resolveSidecarIdleTtlMinutes,
  type SidecarKeepReason,
  type SidecarReapCandidate,
  type SidecarReapConfig,
  type SidecarReapReason,
} from "../../../src/sidecars/policy.js";

const NOW_MS = 1_700_000_000_000;

const DEFAULT_CONFIG: SidecarReapConfig = {
  enabled: true,
  idleTtlMinutes: 120,
  maxAgeWarnMinutes: 360,
};

// Baseline candidate lands on row 11 (within_idle_ttl) unless a test
// overrides the one field the row under test cares about — every earlier
// row's guard is satisfied so overriding a later field never accidentally
// trips an earlier one.
function candidate(overrides: Partial<SidecarReapCandidate> = {}): SidecarReapCandidate {
  return {
    ownerId: "owner-1",
    sidecarName: "front-local",
    tmuxName: "owner-1--front-local",
    paneAlive: true,
    mcp: false,
    ownerExists: true,
    worktreeExists: true,
    workspaceRunning: true,
    hasRecordedIdentity: true,
    lastActivityAtMs: NOW_MS - 1_000,
    idleTtlMinutes: 120,
    connections: "none",
    ageSeconds: 100,
    ...overrides,
  };
}

function planOne(
  overrides: Partial<SidecarReapCandidate>,
  config: SidecarReapConfig = DEFAULT_CONFIG,
) {
  return planSidecarReap({ nowMs: NOW_MS, config, candidates: [candidate(overrides)] });
}

describe("planSidecarReap: decision table", () => {
  it("row 1: config.enabled === false -> keep disabled, regardless of everything else", () => {
    const plan = planOne(
      { ownerExists: false, connections: "none", lastActivityAtMs: null },
      { ...DEFAULT_CONFIG, enabled: false },
    );
    expect(plan.keep).toEqual([
      {
        ownerId: "owner-1",
        sidecarName: "front-local",
        tmuxName: "owner-1--front-local",
        reason: "disabled",
      },
    ]);
    expect(plan.reap).toEqual([]);
  });

  it("row 2: mcp === true -> keep mcp", () => {
    const plan = planOne({ mcp: true, workspaceRunning: false });
    expect(plan.keep[0]?.reason).toBe("mcp");
    expect(plan.reap).toEqual([]);
  });

  it("row 3: no pane and no recorded identity -> keep no_pane_no_identity", () => {
    const plan = planOne({ paneAlive: false, hasRecordedIdentity: false, workspaceRunning: false });
    expect(plan.keep[0]?.reason).toBe("no_pane_no_identity");
  });

  it("row 3 does not fire when a pane is dead but identity is recorded", () => {
    const plan = planOne({ paneAlive: false, hasRecordedIdentity: true, workspaceRunning: false });
    expect(plan.reap[0]?.reason).toBe("workspace_not_running");
  });

  it("row 4: an established connection keeps regardless of owner state", () => {
    const plan = planOne({
      connections: "established",
      ownerExists: false,
      worktreeExists: false,
      workspaceRunning: false,
      lastActivityAtMs: NOW_MS - 1_000_000_000,
    });
    expect(plan.keep[0]?.reason).toBe("connections_established");
  });

  it("row 5 (AC1/AC2): an unknown probe outranks every reap reason, for any owner status or age", () => {
    const plan = planOne({
      connections: "unknown",
      ownerExists: false,
      worktreeExists: false,
      workspaceRunning: false,
      lastActivityAtMs: NOW_MS - 1_000_000_000,
      ageSeconds: 999_999,
    });
    expect(plan.keep[0]?.reason).toBe("probe_unknown");
    expect(plan.reap).toEqual([]);
  });

  it("row 6: a missing owner reaps (owner_missing)", () => {
    const plan = planOne({ ownerExists: false });
    expect(plan.reap[0]?.reason).toBe("owner_missing");
  });

  it("row 7: a missing worktree reaps (worktree_missing)", () => {
    const plan = planOne({ worktreeExists: false });
    expect(plan.reap[0]?.reason).toBe("worktree_missing");
  });

  it("row 8 (AC6): an owner with no running workspace member reaps (workspace_not_running)", () => {
    const plan = planOne({ workspaceRunning: false });
    expect(plan.reap[0]?.reason).toBe("workspace_not_running");
  });

  it("row 9: unknown last activity keeps (activity_unknown)", () => {
    const plan = planOne({ lastActivityAtMs: null });
    expect(plan.keep[0]?.reason).toBe("activity_unknown");
  });

  it("row 10: idle exactly at the TTL boundary reaps (idle_ttl)", () => {
    const plan = planOne({ lastActivityAtMs: NOW_MS - 120 * 60_000, idleTtlMinutes: 120 });
    expect(plan.reap[0]?.reason).toBe("idle_ttl");
  });

  it("row 10 uses the per-candidate idleTtlMinutes override, not the config default", () => {
    const plan = planOne({ lastActivityAtMs: NOW_MS - 10 * 60_000, idleTtlMinutes: 5 });
    expect(plan.reap[0]?.reason).toBe("idle_ttl");
  });

  it("row 11: idle under the TTL keeps (within_idle_ttl)", () => {
    const plan = planOne({ lastActivityAtMs: NOW_MS - (120 * 60_000 - 1), idleTtlMinutes: 120 });
    expect(plan.keep[0]?.reason).toBe("within_idle_ttl");
  });
});

describe("planSidecarReap: age_cap warn", () => {
  it("flags a kept candidate whose age is past maxAgeWarnMinutes", () => {
    const plan = planOne({ ageSeconds: 361 * 60 });
    expect(plan.keep[0]?.reason).toBe("within_idle_ttl");
    expect(plan.warn).toEqual([
      {
        ownerId: "owner-1",
        sidecarName: "front-local",
        tmuxName: "owner-1--front-local",
        reason: "age_cap",
      },
    ]);
  });

  it("never warns a candidate that is already being reaped", () => {
    const plan = planOne({ workspaceRunning: false, ageSeconds: 999_999 });
    expect(plan.reap[0]?.reason).toBe("workspace_not_running");
    expect(plan.warn).toEqual([]);
  });

  it("does not warn when age is unknown", () => {
    const plan = planOne({ ageSeconds: null });
    expect(plan.warn).toEqual([]);
  });

  it("warn never kills: age_cap coexists with a keep verdict, plan.reap stays empty", () => {
    const plan = planOne({ ageSeconds: 400 * 60 });
    expect(plan.reap).toEqual([]);
    expect(plan.warn).toHaveLength(1);
  });
});

describe("planSidecarReap: exhaustiveness and shape", () => {
  it("returns exactly one verdict per candidate (AC1)", () => {
    const candidates = [
      candidate({ sidecarName: "a", mcp: true }),
      candidate({ sidecarName: "b", workspaceRunning: false }),
      candidate({ sidecarName: "c" }),
    ];
    const plan = planSidecarReap({ nowMs: NOW_MS, config: DEFAULT_CONFIG, candidates });
    const total = plan.reap.length + plan.keep.length;
    expect(total).toBe(candidates.length);
  });

  it("every declared reap reason is reachable", () => {
    const reasons: SidecarReapReason[] = [
      "owner_missing",
      "worktree_missing",
      "workspace_not_running",
      "idle_ttl",
    ];
    const overridesByReason: Record<SidecarReapReason, Partial<SidecarReapCandidate>> = {
      owner_missing: { ownerExists: false },
      worktree_missing: { worktreeExists: false },
      workspace_not_running: { workspaceRunning: false },
      idle_ttl: { lastActivityAtMs: NOW_MS - 200 * 60_000 },
    };
    for (const reason of reasons) {
      const plan = planOne(overridesByReason[reason]);
      expect(plan.reap[0]?.reason).toBe(reason);
    }
  });

  it("every declared keep reason is reachable", () => {
    const reasons: SidecarKeepReason[] = [
      "disabled",
      "mcp",
      "no_pane_no_identity",
      "connections_established",
      "probe_unknown",
      "activity_unknown",
      "within_idle_ttl",
    ];
    const overridesByReason: Record<SidecarKeepReason, Partial<SidecarReapCandidate>> = {
      disabled: {},
      mcp: { mcp: true },
      no_pane_no_identity: { paneAlive: false, hasRecordedIdentity: false },
      connections_established: { connections: "established" },
      probe_unknown: { connections: "unknown" },
      activity_unknown: { lastActivityAtMs: null },
      within_idle_ttl: {},
    };
    for (const reason of reasons) {
      const config = reason === "disabled" ? { ...DEFAULT_CONFIG, enabled: false } : DEFAULT_CONFIG;
      const plan = planOne(overridesByReason[reason], config);
      expect(plan.keep[0]?.reason).toBe(reason);
    }
  });
});

describe("resolveSidecarIdleTtlMinutes", () => {
  it("uses the per-sidecar override when present", () => {
    expect(resolveSidecarIdleTtlMinutes(240, 120)).toBe(240);
  });

  it("falls back to the config default when no override is set", () => {
    expect(resolveSidecarIdleTtlMinutes(undefined, 120)).toBe(120);
  });
});
