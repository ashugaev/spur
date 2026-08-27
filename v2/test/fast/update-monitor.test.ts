import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  recordManualRollback,
  runUpdateMonitor,
  type ManualRollbackFailure,
  type UpdateDeps,
} from "../../src/update.js";
import type { SpurLogEntry } from "../../src/event-log.js";
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

type LoggedEvent = Omit<SpurLogEntry, "timestamp">;

interface FakeControls {
  deps: UpdateDeps;
  state: () => RollbackState;
  installLog: string[];
  loggedEvents: LoggedEvent[];
  deployFailures: ManualRollbackFailure[];
  counts: { reinit: number; launch: number };
}

function makeFake(overrides: {
  initialState: RollbackState;
  installed: string;
  probe?: (target: ProbeTarget) => ProbeResult;
  unitState?: (unit: string) => UnitState;
  installVersion?: (target: string) => void;
  reinit?: () => void;
}): FakeControls {
  let state = overrides.initialState;
  let installed = overrides.installed;
  let clock = 0;
  const installLog: string[] = [];
  const loggedEvents: LoggedEvent[] = [];
  const deployFailures: ManualRollbackFailure[] = [];
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
      if (overrides.installVersion) {
        overrides.installVersion(target);
        return;
      }
      installLog.push(target);
      installed = target;
    },
    reinit: () => {
      counts.reinit += 1;
      overrides.reinit?.();
    },
    currentVersion: "0.1.5",
    readInstalledVersion: () => installed,
    readState: () => state,
    writeState: (next) => {
      state = next;
    },
    readWebPort: () => 4311,
    readDaemonPort: () => 4310,
    launch: () => {
      counts.launch += 1;
      return { kind: "process", pid: 1 };
    },
    stopMonitor: () => undefined,
    pidAlive: () => false,
    unitActive: () => false,
    log: () => undefined,
    logEvent: (event, entry) => {
      loggedEvents.push({ event, ...entry });
    },
    recordDeployFailure: (failure) => {
      deployFailures.push(failure);
    },
    acquireUpdateLock: () => () => undefined,
  };
  return { deps, state: () => state, installLog, loggedEvents, deployFailures, counts };
}

function monitoringState(installed: string, lastKnownGood: string | null): RollbackState {
  return {
    version: 1,
    lastKnownGood: lastKnownGood
      ? { version: lastKnownGood, healthyAt: "2026-07-12T00:00:00.000Z" }
      : null,
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
    expect(fake.loggedEvents).toEqual([
      {
        event: "cli.update.abandoned",
        level: "warn",
        details: { version: "0.2.0", reason: "deadline" },
      },
    ]);
  });

  it("logs cli.update.rolled_back on rollback", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(fake.loggedEvents).toEqual([
      {
        event: "cli.update.rolled_back",
        level: "warn",
        details: {
          from: "0.1.5",
          to: "0.2.0",
          reason: expect.any(String),
          failureKind: "rolled_back",
        },
      },
    ]);
  });

  it("logs install_unhealthy when there is no known-good version to reinstall", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", null),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(fake.installLog).toEqual([]);
    expect(fake.loggedEvents).toEqual([
      {
        event: "cli.update.rolled_back",
        level: "warn",
        details: {
          from: "0.1.5",
          to: "0.2.0",
          reason: expect.any(String),
          failureKind: "install_unhealthy",
        },
      },
    ]);
  });

  it("logs install_unhealthy and rethrows when the reinit behind the rollback install fails", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
      reinit: () => {
        throw new Error("npm init script not found");
      },
    });
    await expect(runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG)).rejects.toThrow(
      "npm init script not found",
    );
    expect(fake.installLog).toEqual(["0.1.5"]);
    expect(fake.loggedEvents).toEqual([
      {
        event: "cli.update.rolled_back",
        level: "warn",
        details: {
          from: "0.1.5",
          to: "0.2.0",
          reason: expect.any(String),
          failureKind: "install_unhealthy",
        },
      },
    ]);
  });

  it("logs install_unhealthy and rethrows when the rollback install itself fails", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      unitState: (unit) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }),
      installVersion: () => {
        throw new Error("npm install failed");
      },
    });
    await expect(runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG)).rejects.toThrow(
      "npm install failed",
    );
    expect(fake.loggedEvents).toEqual([
      {
        event: "cli.update.rolled_back",
        level: "warn",
        details: {
          from: "0.1.5",
          to: "0.2.0",
          reason: expect.any(String),
          failureKind: "install_unhealthy",
        },
      },
    ]);
  });

  it("records a manual rollback for the UI on every exit that rolls back", async () => {
    const rollingBack = {
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      unitState: (unit: string) => (unit === "spur-daemon.service" ? "failed" : "active"),
      probe: () => ({ ok: false, reason: "http-error" }) as const,
    };
    const expected = {
      version: "0.2.0",
      startedAt: "2026-07-12T00:00:00.000Z",
    };

    const full = makeFake(rollingBack);
    await runUpdateMonitor("/tmp/cli.js", full.deps, FAST_CFG);
    expect(full.deployFailures).toEqual([{ ...expected, failureKind: "rolled_back" }]);

    // Known-good already installed: nothing to reinstall, still a rollback.
    const matching = makeFake({
      ...rollingBack,
      initialState: monitoringState("0.2.0", "0.2.0"),
    });
    await runUpdateMonitor("/tmp/cli.js", matching.deps, FAST_CFG);
    expect(matching.deployFailures).toEqual([{ ...expected, failureKind: "rolled_back" }]);
    expect(matching.installLog).toEqual([]);

    const noKnownGood = makeFake({ ...rollingBack, initialState: monitoringState("0.2.0", null) });
    await runUpdateMonitor("/tmp/cli.js", noKnownGood.deps, FAST_CFG);
    expect(noKnownGood.deployFailures).toEqual([{ ...expected, failureKind: "install_unhealthy" }]);

    const throwing = makeFake({
      ...rollingBack,
      installVersion: () => {
        throw new Error("npm install failed");
      },
    });
    await expect(runUpdateMonitor("/tmp/cli.js", throwing.deps, FAST_CFG)).rejects.toThrow(
      "npm install failed",
    );
    expect(throwing.deployFailures).toEqual([{ ...expected, failureKind: "install_unhealthy" }]);
  });

  it("records nothing when the monitor commits instead of rolling back", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(fake.deployFailures).toEqual([]);
  });

  it("records nothing on the abandon path, which leaves the new version running", async () => {
    const fake = makeFake({
      initialState: monitoringState("0.2.0", "0.1.5"),
      installed: "0.2.0",
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdateMonitor("/tmp/cli.js", fake.deps, FAST_CFG);
    expect(fake.deployFailures).toEqual([]);
  });
});

describe("recordManualRollback", () => {
  async function newDataDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "spur-manual-rollback-"));
  }

  const FAILURE: ManualRollbackFailure = {
    version: "0.2.0",
    startedAt: "2026-07-12T00:00:00.000Z",
    failureKind: "rolled_back",
  };

  it("writes the failed record and one blocked ledger line", async () => {
    const dataDir = await newDataDir();

    recordManualRollback(dataDir, FAILURE);

    const record: unknown = JSON.parse(
      await readFile(join(dataDir, "deploy-switch.json"), "utf8"),
    ) as unknown;
    expect(record).toEqual({
      phase: "failed",
      version: "0.2.0",
      pid: process.pid,
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: expect.any(String),
      exitCode: -1,
      initiator: "manual",
      failureKind: "rolled_back",
    });
    const ledger = await readFile(join(dataDir, "update-ledger.jsonl"), "utf8");
    expect(ledger.trimEnd().split("\n")).toHaveLength(1);
    expect(ledger).toContain('{"kind":"blocked","version":"0.2.0","failureKind":"rolled_back"');
  });

  it("writes nothing while a deploy switch is running", async () => {
    const dataDir = await newDataDir();
    const statePath = join(dataDir, "deploy-switch.json");
    const running = `${JSON.stringify({
      phase: "running",
      version: "0.3.0",
      pid: process.pid,
      processStartTime: "1",
      startedAt: "2026-07-12T00:00:00.000Z",
      initiator: "manual",
    })}\n`;
    await writeFile(statePath, running, "utf8");

    recordManualRollback(dataDir, FAILURE);

    expect(await readFile(statePath, "utf8")).toBe(running);
    expect(existsSync(join(dataDir, "update-ledger.jsonl"))).toBe(false);
  });

  it("supersedes a terminal record from an earlier switch", async () => {
    const dataDir = await newDataDir();
    const statePath = join(dataDir, "deploy-switch.json");
    await writeFile(
      statePath,
      `${JSON.stringify({
        phase: "succeeded",
        version: "0.1.9",
        pid: 4242,
        startedAt: "2026-07-11T00:00:00.000Z",
        finishedAt: "2026-07-11T00:01:00.000Z",
        exitCode: 0,
        initiator: "auto",
      })}\n`,
      "utf8",
    );

    recordManualRollback(dataDir, { ...FAILURE, failureKind: "install_unhealthy" });

    expect(await readFile(statePath, "utf8")).toContain('"failureKind":"install_unhealthy"');
  });
});
