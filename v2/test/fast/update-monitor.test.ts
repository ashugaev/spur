import { describe, expect, it } from "vitest";
import { runUpdateMonitor, type UpdateDeps } from "../../src/update.js";
import type { DecisionConfig } from "../../src/update-decision.js";
import type { ProbeResult, ProbeTarget, UnitState } from "../../src/update-health.js";
import type { RollbackState } from "../../src/update-state.js";

const FAST_CFG: DecisionConfig = {
  warmupMs: 0,
  pollMs: 1,
  stableK: 3,
  deadlineMs: 3,
  refusedN: 3,
};

interface FakeControls {
  deps: UpdateDeps;
  state: () => RollbackState;
  installLog: string[];
  counts: { reinit: number; launch: number };
}

function makeFake(overrides: {
  initialState: RollbackState;
  installed: string;
  probe?: (target: ProbeTarget) => ProbeResult;
  unitState?: (unit: string) => UnitState;
}): FakeControls {
  let state = overrides.initialState;
  let installed = overrides.installed;
  let clock = 0;
  const installLog: string[] = [];
  const counts = { reinit: 0, launch: 0 };
  const deps: UpdateDeps = {
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    probe: (target) => Promise.resolve(overrides.probe?.(target) ?? { ok: true }),
    unitState: (unit) => Promise.resolve(overrides.unitState?.(unit) ?? "active"),
    installVersion: (target) => {
      installLog.push(target);
      installed = target;
    },
    reinit: () => {
      counts.reinit += 1;
    },
    currentVersion: "0.1.5",
    readInstalledVersion: () => installed,
    readState: () => state,
    writeState: (next) => {
      state = next;
    },
    readWebPort: () => 4311,
    launch: () => {
      counts.launch += 1;
      return { kind: "process", pid: 1 };
    },
    stopMonitor: () => undefined,
    pidAlive: () => false,
    unitActive: () => false,
    log: () => undefined,
  };
  return { deps, state: () => state, installLog, counts };
}

function monitoringState(installed: string, lastKnownGood: string | null): RollbackState {
  return {
    version: 1,
    lastKnownGood: lastKnownGood ? { version: lastKnownGood, healthyAt: "2026-07-12T00:00:00.000Z" } : null,
    inProgress: {
      fromVersion: "0.1.5",
      toVersion: installed,
      monitor: { kind: "process", pid: 1 },
      startedAt: "2026-07-12T00:00:00.000Z",
      phase: "monitoring",
    },
  };
}

describe("runUpdateMonitor", () => {
  it("exits immediately when no update is being monitored", async () => {
    let probed = false;
    const fake = makeFake({
      initialState: { version: 1, lastKnownGood: null, inProgress: null },
      installed: "0.2.0",
      probe: () => {
        probed = true;
        return { ok: true };
      },
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(probed).toBe(false);
  });

  it("commits the new installed version and clears inProgress without installing", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    const state = fake.state();
    expect(state.inProgress).toBeNull();
    expect(state.lastKnownGood).toEqual({ version: "0.2.0", healthyAt: expect.any(String) });
    expect(fake.installLog).toEqual([]);
    expect(fake.counts.launch).toBe(0);
  });

  it("rolls back to the recorded good version, reinstalls, verifies, and clears inProgress", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    const state = fake.state();
    expect(fake.installLog).toEqual(["0.1.5"]);
    expect(fake.counts.reinit).toBe(1);
    expect(fake.counts.launch).toBe(0);
    expect(state.inProgress).toBeNull();
  });

  it("skips reinstall when the recorded good version already matches the installed one", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.2.0"),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(fake.installLog).toEqual([]);
    expect(fake.counts.launch).toBe(0);
    expect(fake.state().inProgress).toBeNull();
  });

  it("does not re-enter rollback or spawn a monitor when post-rollback verify keeps failing", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(fake.installLog).toEqual(["0.1.5"]);
    expect(fake.counts.launch).toBe(0);
    expect(fake.state().inProgress).toBeNull();
  });

  it("abandons at the deadline and leaves the prior known-good untouched", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    const state = fake.state();
    expect(fake.installLog).toEqual([]);
    expect(state.inProgress).toBeNull();
    expect(state.lastKnownGood).toEqual({
      version: "0.1.5",
      healthyAt: "2026-07-12T00:00:00.000Z",
    });
  });
});
