import { describe, expect, it, vi } from "vitest";
import { runAutoUpdateTick, type RunAutoUpdateTickDeps } from "../../src/auto-update.js";
import type { DeploySwitchResult } from "../../src/deploy-switch.js";
import type { DeployFailureKind, DeploySwitchState } from "../../src/deploy-switch-state.js";

function baseDeps(overrides: Partial<RunAutoUpdateTickDeps> = {}): RunAutoUpdateTickDeps {
  return {
    configPath: "/tmp/spur-config.yaml",
    statePath: "/tmp/spur-deploy-switch.json",
    currentVersion: "1.0.0",
    readFlag: () => ({ autoUpdate: true, error: null }),
    readState: () => null,
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
): DeploySwitchState {
  return {
    phase,
    version,
    pid: 1234,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
    exitCode: phase === "succeeded" ? 0 : 1,
    initiator: "auto",
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
    const deps = baseDeps({ readState: () => terminalState("succeeded", "1.1.0"), start, log });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        level: "warn",
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
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "rolled_back"),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        level: "warn",
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
    const deps = baseDeps({
      readState: () => terminalState("failed", "1.1.0", "install_unhealthy"),
      start,
      log,
    });

    await runAutoUpdateTick(deps);

    expect(start).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "daemon.auto_update.suppressed",
      expect.objectContaining({
        level: "warn",
        details: expect.objectContaining({
          failureKind: "install_unhealthy",
          reason: "no_retry_kind",
        }),
      }),
    );
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
