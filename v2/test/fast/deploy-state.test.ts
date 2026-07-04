import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWITCH_STALE_MS,
  isSwitchInProgress,
  publicSwitchState,
  readSwitchState,
  switchStatePath,
  type SwitchState,
} from "../../src/deploy-state.js";

async function writeState(dataDir: string, content: string): Promise<void> {
  await mkdir(join(dataDir, "deploy"), { recursive: true });
  await writeFile(switchStatePath(dataDir), content, "utf8");
}

const VALID: SwitchState = {
  phase: "done",
  from: "0.1.1",
  to: "0.1.2",
  startedAt: "2026-07-04T12:00:00Z",
  finishedAt: "2026-07-04T12:01:30Z",
  error: "boom",
  pid: 4242,
};

describe("readSwitchState", () => {
  it("returns null when the file is missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    expect(readSwitchState(dataDir)).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    await writeState(dataDir, "{not json");
    expect(readSwitchState(dataDir)).toBeNull();
  });

  it("returns null on an unknown phase or missing fields", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    await writeState(dataDir, JSON.stringify({ ...VALID, phase: "exploded" }));
    expect(readSwitchState(dataDir)).toBeNull();
    await writeState(dataDir, JSON.stringify({ phase: "done", from: "0.1.1" }));
    expect(readSwitchState(dataDir)).toBeNull();
  });

  it("round-trips a valid file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    await writeState(dataDir, JSON.stringify(VALID));
    expect(readSwitchState(dataDir)).toEqual(VALID);
  });
});

describe("isSwitchInProgress", () => {
  const at = Date.parse("2026-07-04T12:00:00Z");

  it("is true for fresh installing and restarting phases", () => {
    const state = { ...VALID, phase: "installing" as const };
    expect(isSwitchInProgress(state, at + 60_000)).toBe(true);
    expect(isSwitchInProgress({ ...state, phase: "restarting" }, at + 60_000)).toBe(true);
  });

  it("is false for terminal phases", () => {
    expect(isSwitchInProgress({ ...VALID, phase: "done" }, at)).toBe(false);
    expect(isSwitchInProgress({ ...VALID, phase: "rolled_back" }, at)).toBe(false);
    expect(isSwitchInProgress({ ...VALID, phase: "failed" }, at)).toBe(false);
  });

  it("goes stale after the staleness window", () => {
    const state = { ...VALID, phase: "installing" as const };
    expect(isSwitchInProgress(state, at + SWITCH_STALE_MS - 1)).toBe(true);
    expect(isSwitchInProgress(state, at + SWITCH_STALE_MS)).toBe(false);
  });

  it("is false when startedAt is unparseable", () => {
    expect(isSwitchInProgress({ ...VALID, phase: "installing", startedAt: "nope" }, at)).toBe(
      false,
    );
  });
});

describe("publicSwitchState", () => {
  it("drops the pid", () => {
    expect(publicSwitchState(VALID)).toEqual({
      phase: "done",
      from: "0.1.1",
      to: "0.1.2",
      startedAt: "2026-07-04T12:00:00Z",
      finishedAt: "2026-07-04T12:01:30Z",
      error: "boom",
    });
  });
});
