import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearFailedDeploySwitchRecord,
  readDeploySwitchState,
  readProcessStartTime,
  reconcileDeploySwitchState,
  writeDeploySwitchState,
  type DeploySwitchState,
} from "../../src/deploy-switch-state.js";

async function newStatePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "spur-deploy-state-")), "deploy-switch.json");
}

// One terminal record, reused by the round-trip and the two rejection cases so
// only the field under test differs between them.
const TERMINAL = {
  phase: "failed",
  version: "0.67.2",
  pid: 4242,
  startedAt: "2026-08-24T15:17:00Z",
  finishedAt: "2026-08-24T15:17:02Z",
  exitCode: 1,
} as const;

describe("deploy switch state", () => {
  it("keeps a running record only while the exact process identity is alive", async () => {
    const path = await newStatePath();
    const processStartTime = readProcessStartTime(process.pid);
    if (!processStartTime) throw new Error("current process has no Linux start time");
    writeDeploySwitchState(path, {
      phase: "running",
      version: "1.2.3",
      pid: process.pid,
      processStartTime,
      startedAt: "2026-08-12T00:00:00Z",
      initiator: "manual",
    });

    expect(reconcileDeploySwitchState(path)?.phase).toBe("running");

    writeDeploySwitchState(path, {
      phase: "running",
      version: "1.2.3",
      pid: process.pid,
      processStartTime: `${processStartTime}-reused`,
      startedAt: "2026-08-12T00:00:00Z",
      initiator: "auto",
    });
    expect(reconcileDeploySwitchState(path)).toEqual(
      expect.objectContaining({ phase: "failed", exitCode: -1, initiator: "auto" }),
    );
  });

  it("round-trips the initiator and the failure kind on a terminal record", async () => {
    const path = await newStatePath();
    const record = { ...TERMINAL, initiator: "auto", failureKind: "rolled_back" } as const;
    writeDeploySwitchState(path, record);

    expect(readDeploySwitchState(path)).toEqual(record);
  });

  it("reads a legacy record without an initiator as no record at all", async () => {
    const path = await newStatePath();
    await writeFile(path, `${JSON.stringify(TERMINAL)}\n`, "utf8");

    expect(readDeploySwitchState(path)).toBeNull();
  });

  it("rejects a record whose failureKind is not one of the three kinds", async () => {
    const path = await newStatePath();
    const record = { ...TERMINAL, initiator: "auto", failureKind: "something_else" };
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    expect(readDeploySwitchState(path)).toBeNull();
  });

  it("clears a failed record whose kind is a no-retry kind", async () => {
    for (const failureKind of ["rolled_back", "install_unhealthy"] as const) {
      const path = await newStatePath();
      writeDeploySwitchState(path, { ...TERMINAL, initiator: "auto", failureKind });

      clearFailedDeploySwitchRecord(path);

      expect(existsSync(path)).toBe(false);
      expect(readDeploySwitchState(path)).toBeNull();
    }
  });

  it("leaves every record the notice is not derived from in place", async () => {
    const processStartTime = readProcessStartTime(process.pid);
    if (!processStartTime) throw new Error("current process has no Linux start time");
    const records: DeploySwitchState[] = [
      { ...TERMINAL, initiator: "auto", failureKind: "install_failed" },
      { ...TERMINAL, initiator: "auto" },
      { ...TERMINAL, phase: "succeeded", exitCode: 0, initiator: "auto" },
      // The union admits a kind on a `succeeded` record even though no writer
      // produces one: the phase, not the kind alone, decides.
      {
        ...TERMINAL,
        phase: "succeeded",
        exitCode: 0,
        initiator: "auto",
        failureKind: "rolled_back",
      },
      {
        phase: "running",
        version: "0.67.2",
        pid: process.pid,
        processStartTime,
        startedAt: "2026-08-24T15:17:00Z",
        initiator: "manual",
      },
    ];
    for (const record of records) {
      const path = await newStatePath();
      writeDeploySwitchState(path, record);

      clearFailedDeploySwitchRecord(path);

      expect(readDeploySwitchState(path)).toEqual(record);
    }
  });

  it("is a no-op when there is no record at all", async () => {
    const path = await newStatePath();

    expect(() => clearFailedDeploySwitchRecord(path)).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
