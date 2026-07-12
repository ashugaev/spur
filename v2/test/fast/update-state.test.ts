import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultState,
  isMonitorLive,
  readState,
  writeState,
  type RollbackState,
} from "../../src/update-state.js";

async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-update-state-"));
  return join(dir, "rollback-state.json");
}

describe("update-state", () => {
  it("returns the default state when the file is missing", async () => {
    const path = await tempStatePath();
    expect(readState(path)).toEqual(defaultState());
  });

  it("returns the default state when the file is malformed JSON", async () => {
    const path = await tempStatePath();
    await writeFile(path, "{ not json", "utf-8");
    expect(readState(path)).toEqual(defaultState());
  });

  it("returns the default state when the shape is invalid", async () => {
    const path = await tempStatePath();
    await writeFile(path, JSON.stringify({ version: 2, foo: true }), "utf-8");
    expect(readState(path)).toEqual(defaultState());
  });

  it("round-trips lastKnownGood and inProgress atomically", async () => {
    const path = await tempStatePath();
    const state: RollbackState = {
      version: 1,
      lastKnownGood: { version: "0.1.5", healthyAt: "2026-07-12T00:00:00.000Z" },
      inProgress: {
        fromVersion: "0.1.5",
        toVersion: "0.2.0",
        monitor: { kind: "systemd", unit: "spur-update-monitor.service" },
        startedAt: "2026-07-12T00:00:01.000Z",
        phase: "monitoring",
      },
    };
    writeState(path, state);
    const raw = await readFile(path, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(readState(path)).toEqual(state);
  });

  it("round-trips a process monitor ref and an installing phase with a null monitor", async () => {
    const path = await tempStatePath();
    const state: RollbackState = {
      version: 1,
      lastKnownGood: null,
      inProgress: {
        fromVersion: "0.1.5",
        toVersion: "latest",
        monitor: null,
        startedAt: "2026-07-12T00:00:01.000Z",
        phase: "installing",
      },
    };
    writeState(path, state);
    expect(readState(path)).toEqual(state);

    const inProgress = state.inProgress;
    if (!inProgress) throw new Error("expected inProgress");
    const withPid: RollbackState = {
      ...state,
      inProgress: { ...inProgress, monitor: { kind: "process", pid: 4242 } },
    };
    writeState(path, withPid);
    expect(readState(path)).toEqual(withPid);
  });

  it("isMonitorLive resolves systemd refs via unitActive", () => {
    const ref = { kind: "systemd" as const, unit: "spur-update-monitor.service" };
    expect(
      isMonitorLive(ref, { pidAlive: () => false, unitActive: () => true }),
    ).toBe(true);
    expect(
      isMonitorLive(ref, { pidAlive: () => true, unitActive: () => false }),
    ).toBe(false);
  });

  it("isMonitorLive resolves process refs via pidAlive", () => {
    const ref = { kind: "process" as const, pid: 99 };
    expect(isMonitorLive(ref, { pidAlive: () => true, unitActive: () => false })).toBe(true);
    expect(isMonitorLive(ref, { pidAlive: () => false, unitActive: () => true })).toBe(false);
  });

  it("isMonitorLive treats a null ref as not live", () => {
    expect(isMonitorLive(null, { pidAlive: () => true, unitActive: () => true })).toBe(false);
  });
});
