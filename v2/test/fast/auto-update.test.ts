import { describe, expect, it, vi } from "vitest";
import type { WriteAutoUpdateResult } from "../../src/auto-update-config.js";
import { runAutoUpdateTick, type RunAutoUpdateTickDeps } from "../../src/auto-update.js";
import type { DeploySwitchResult } from "../../src/deploy-switch.js";
import type {
  DeployFailureKind,
  DeployInitiator,
  DeploySwitchState,
} from "../../src/deploy-switch-state.js";
import type { UpdateLedger } from "../../src/update-ledger.js";

function ledger(entries: { blocked?: string[]; disarmed?: string[] } = {}): UpdateLedger {
  const at = "2026-01-01T00:00:00Z";
  return {
    blocked: new Map(
      (entries.blocked ?? []).map((version) => [
        version,
        { kind: "blocked", version, failureKind: "rolled_back", at } as const,
      ]),
    ),
    disarmed: new Map(
      (entries.disarmed ?? []).map((version) => [
        version,
        { kind: "disarmed", version, at } as const,
      ]),
    ),
  };
}

function baseDeps(overrides: Partial<RunAutoUpdateTickDeps> = {}): RunAutoUpdateTickDeps {
  return {
    configPath: "/tmp/spur-config.yaml",
    statePath: "/tmp/spur-deploy-switch.json",
    ledgerPath: "/tmp/spur-update-ledger.jsonl",
    currentVersion: "1.0.0",
    readFlag: () => ({ autoUpdate: true, error: null }),
    readState: () => null,
    readLedger: () => ledger(),
    appendLedger: vi.fn(),
    disarm: vi.fn((): WriteAutoUpdateResult => ({ ok: true, autoUpdate: false })),
    getReleases: async () => ({
      entries: [{ tag: "1.1.0", publishedAt: "2026-01-01T00:00:00Z" }],
      stale: false,
      error: null,
    }),
    start: vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    ),
    log: vi.fn(),
    ...overrides,
  };
}

function runningState(version: string): DeploySwitchState {
  return {
    phase: "running",
    version,
    pid: 1234,
    processStartTime: "100",
    startedAt: "2026-01-01T00:00:00Z",
    initiator: "auto",
  };
}

function terminalState(
  phase: "succeeded" | "failed",
  version: string,
  failureKind?: DeployFailureKind,
  initiator: DeployInitiator = "auto",
): DeploySwitchState {
  return {
    phase,
    version,
    pid: 1234,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
    exitCode: phase === "succeeded" ? 0 : 1,
    initiator,
    ...(failureKind ? { failureKind } : {}),
  };
}

describe("runAutoUpdateTick", () => {
  it("does not call start when the flag is off", async () => {
    const start = vi.fn();
    const deps = baseDeps({ readFlag: () => ({ autoUpdate: false, error: null }), start });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
  });

  it("logs config_invalid and still returns without calling start when readFlag reports an error", async () => {
    const start = vi.fn();
    const log = vi.fn();
    const deps = baseDeps({
      readFlag: () => ({ autoUpdate: false, error: "config must be an object" }),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.config_invalid",
      expect.objectContaining({ level: "warn", message: "config must be an object" }),
    );
  });

  it("does not call start when a switch is already running", async () => {
    const start = vi.fn();
    const deps = baseDeps({ readState: () => runningState("1.1.0"), start });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
  });

  it("does not call start when the registry is empty", async () => {
    const start = vi.fn();
    const deps = baseDeps({
      getReleases: async () => ({ entries: [], stale: false, error: null }),
      start,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
  });

  it("does not call start when the newest release is not strictly newer than the current version", async () => {
    const start = vi.fn();
    const deps = baseDeps({
      currentVersion: "1.1.0",
      getReleases: async () => ({
        entries: [{ tag: "1.1.0", publishedAt: "2026-01-01T00:00:00Z" }],
        stale: false,
        error: null,
      }),
      start,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
  });

  it("does not call start when the current version is not a release string", async () => {
    // `getVersion()`'s `--always` fallback with no matching tags at all
    // returns the bare abbreviated SHA (no dots); `Number.parseInt` on its
    // leading, non-digit character yields NaN, and every NaN comparison is
    // false, so the "strictly newer" test fails closed.
    const start = vi.fn();
    const deps = baseDeps({ currentVersion: "a1b2c3d", start });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
  });

  it("suppresses a succeeded record and logs the reason", async () => {
    const start = vi.fn();
    const log = vi.fn();
    const disarm = vi.fn();
    const deps = baseDeps({
      readState: () => terminalState("succeeded", "1.1.0"),
      start,
      log,
      disarm,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    // A succeeded switch is not a failure: nothing to disarm.
    expect(disarm).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        // `info`, not `warn`: a suppressed tick took no action, and it repeats
        // every 5 minutes for as long as this release is the newest one.
        level: "info",
        details: {
          version: "1.1.0",
          phase: "succeeded",
          initiator: "auto",
          reason: "succeeded_record",
        },
      }),
    );
  });

  it("suppresses rolled_back and logs the reason", async () => {
    const start = vi.fn();
    const log = vi.fn();
    // The flag is on again with the record still standing, i.e. the operator
    // hand-edited the config after the one disarm this version ever gets.
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "rolled_back"),
      readLedger: () => ledger({ disarmed: ["1.1.0"] }),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        level: "info",
        details: {
          version: "1.1.0",
          phase: "failed",
          failureKind: "rolled_back",
          initiator: "auto",
          reason: "no_retry_kind",
        },
      }),
    );
  });

  it("suppresses install_unhealthy and logs the reason", async () => {
    const start = vi.fn();
    const log = vi.fn();
    const disarm = vi.fn();
    // `spur update` rolled this version back and left `autoUpdate` alone —
    // there was nothing to disable on the manual path.
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "install_unhealthy", "manual"),
      start,
      log,
      disarm,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(disarm).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        level: "info",
        details: expect.objectContaining({
          failureKind: "install_unhealthy",
          initiator: "manual",
          reason: "no_retry_kind",
        }),
      }),
    );
  });

  it("disarms after an auto-initiated rollback and never fetches releases", async () => {
    const start = vi.fn();
    const log = vi.fn();
    const appendLedger = vi.fn();
    const disarm = vi.fn((): WriteAutoUpdateResult => ({ ok: true, autoUpdate: false }));
    const getReleases = vi.fn(async () => ({ entries: [], stale: false, error: null }));
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "rolled_back"),
      appendLedger,
      disarm,
      start,
      log,
      getReleases,
    });

    await runAutoUpdateTick(deps);

    expect(disarm).toHaveBeenCalledTimes(1);
    expect(disarm).toHaveBeenCalledWith("/tmp/spur-config.yaml");
    expect(getReleases).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(appendLedger).toHaveBeenCalledTimes(1);
    expect(appendLedger).toHaveBeenCalledWith(
      "/tmp/spur-update-ledger.jsonl",
      expect.objectContaining({ kind: "disarmed", version: "1.1.0" }),
    );
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.paused",
      expect.objectContaining({
        level: "warn",
        details: { version: "1.1.0", failureKind: "rolled_back" },
      }),
    );
  });

  it("disarms for install_unhealthy too", async () => {
    const disarm = vi.fn((): WriteAutoUpdateResult => ({ ok: true, autoUpdate: false }));
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "install_unhealthy"),
      disarm,
    });

    await runAutoUpdateTick(deps);

    expect(disarm).toHaveBeenCalledTimes(1);
  });

  it("does not disarm for a manual-initiated rollback", async () => {
    const disarm = vi.fn();
    const appendLedger = vi.fn();
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "rolled_back", "manual"),
      disarm,
      appendLedger,
    });

    await runAutoUpdateTick(deps);

    expect(disarm).not.toHaveBeenCalled();
    expect(appendLedger).not.toHaveBeenCalled();
  });

  it("does not disarm for a kind that installed nothing", async () => {
    const disarm = vi.fn();
    const start = vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    );
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "install_failed"),
      disarm,
      start,
    });

    await runAutoUpdateTick(deps);

    expect(disarm).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith("1.1.0");
  });

  it("does not re-disarm a version already marked disarmed", async () => {
    const disarm = vi.fn();
    const appendLedger = vi.fn();
    // Hand-edited back to `autoUpdate: true` with the record untouched: the
    // marker is the only thing that stops the daemon rewriting the file on
    // every tick, forever.
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "rolled_back"),
      readLedger: () => ledger({ disarmed: ["1.1.0"] }),
      disarm,
      appendLedger,
    });

    await runAutoUpdateTick(deps);

    expect(disarm).not.toHaveBeenCalled();
    expect(appendLedger).not.toHaveBeenCalled();
  });

  it("appends no marker and logs disarm_failed when the config write fails", async () => {
    const appendLedger = vi.fn();
    const log = vi.fn();
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "rolled_back"),
      disarm: () => ({ ok: false, reason: "conflict", message: "config changed on disk" }),
      appendLedger,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(appendLedger).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.disarm_failed",
      expect.objectContaining({
        level: "warn",
        details: { reason: "conflict", message: "config changed on disk" },
      }),
    );
  });

  it("suppresses a blocked version with no matching record", async () => {
    const start = vi.fn();
    const log = vi.fn<RunAutoUpdateTickDeps["log"]>();
    // The record behind the notice was cleared by a Switch or by re-arming
    // AUTO; the ledger is what keeps the version off the auto path.
    const deps = baseDeps({
      readState: () => null,
      readLedger: () => ledger({ blocked: ["1.1.0"] }),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        level: "info",
        details: { version: "1.1.0", reason: "blocked_version" },
      }),
    );
    // A tick that suppressed the newest release repeats every 5 minutes for as
    // long as that release stands: nothing on it may reach `warn`.
    expect(log.mock.calls.map(([, entry]) => entry.level)).toEqual(["info"]);
  });

  it("still starts a newer candidate that the ledger does not name", async () => {
    const start = vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    );
    const deps = baseDeps({
      readLedger: () => ledger({ blocked: ["1.0.9"], disarmed: ["1.0.9"] }),
      start,
    });

    await runAutoUpdateTick(deps);

    expect(start).toHaveBeenCalledWith("1.1.0");
  });

  it("retries a failed install_failed record", async () => {
    const start = vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    );
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "install_failed"),
      start,
    });

    await runAutoUpdateTick(deps);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("1.1.0");
  });

  it("retries a failed record with no failureKind", async () => {
    const start = vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    );
    const deps = baseDeps({ readState: () => terminalState("failed", "1.1.0"), start });

    await runAutoUpdateTick(deps);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("1.1.0");
  });

  it("logs retry before starting a previously failed candidate", async () => {
    const calls: string[] = [];
    const start = vi.fn(async (version: string): Promise<DeploySwitchResult> => {
      calls.push(`start:${version}`);
      return { status: "accepted", version };
    });
    const log = vi.fn((event: string) => {
      calls.push(`log:${event}`);
    });
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "install_failed"),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.retry",
      expect.objectContaining({
        level: "info",
        details: {
          version: "1.1.0",
          failureKind: "install_failed",
          previousExitCode: 1,
        },
      }),
    );
    expect(calls).toEqual([
      "log:daemon.auto_update.retry",
      "start:1.1.0",
      "log:daemon.auto_update.started",
    ]);
  });

  it("does not suppress when a terminal record names a different version", async () => {
    const start = vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    );
    const deps = baseDeps({ readState: () => terminalState("succeeded", "1.0.5"), start });

    await runAutoUpdateTick(deps);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("1.1.0");
  });

  it("calls start exactly once with the newest tag on the happy path", async () => {
    const start = vi.fn(
      async (version: string): Promise<DeploySwitchResult> => ({ status: "accepted", version }),
    );
    const log = vi.fn();
    const deps = baseDeps({
      getReleases: async () => ({
        entries: [
          { tag: "1.2.0", publishedAt: "2026-02-01T00:00:00Z" },
          { tag: "1.1.0", publishedAt: "2026-01-01T00:00:00Z" },
        ],
        stale: false,
        error: null,
      }),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("1.2.0");
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.started",
      expect.objectContaining({ level: "info" }),
    );
  });

  it("logs skipped when start returns a non-accepted result", async () => {
    const log = vi.fn();
    const deps = baseDeps({
      start: async (version: string): Promise<DeploySwitchResult> => ({
        status: "already_current",
        version,
      }),
      log,
    });

    await runAutoUpdateTick(deps);

    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.skipped",
      expect.objectContaining({
        level: "info",
        details: { status: "already_current", version: "1.1.0" },
      }),
    );
  });
});
