import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDeploySwitchState,
  readProcessStartTime,
  reconcileDeploySwitchState,
  writeDeploySwitchState,
} from "../../src/deploy-switch-state.js";

describe("deploy switch state", () => {
  it("keeps a running record only while the exact process identity is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    const path = join(root, "deploy-switch.json");
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
    const root = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    const path = join(root, "deploy-switch.json");
    writeDeploySwitchState(path, {
      phase: "failed",
      version: "0.67.2",
      pid: 4242,
      startedAt: "2026-08-24T15:17:00Z",
      finishedAt: "2026-08-24T15:17:02Z",
      exitCode: 1,
      initiator: "auto",
      failureKind: "rolled_back",
    });

    expect(readDeploySwitchState(path)).toEqual({
      phase: "failed",
      version: "0.67.2",
      pid: 4242,
      startedAt: "2026-08-24T15:17:00Z",
      finishedAt: "2026-08-24T15:17:02Z",
      exitCode: 1,
      initiator: "auto",
      failureKind: "rolled_back",
    });
  });

  it("reads a legacy record without an initiator as no record at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    const path = join(root, "deploy-switch.json");
    await writeFile(
      path,
      `${JSON.stringify({
        phase: "failed",
        version: "0.67.2",
        pid: 4242,
        startedAt: "2026-08-24T15:17:00Z",
        finishedAt: "2026-08-24T15:17:02Z",
        exitCode: 1,
      })}\n`,
      "utf8",
    );

    expect(readDeploySwitchState(path)).toBeNull();
  });

  it("rejects a record whose failureKind is not one of the three kinds", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-deploy-state-"));
    const path = join(root, "deploy-switch.json");
    await writeFile(
      path,
      `${JSON.stringify({
        phase: "failed",
        version: "0.67.2",
        pid: 4242,
        startedAt: "2026-08-24T15:17:00Z",
        finishedAt: "2026-08-24T15:17:02Z",
        exitCode: 1,
        initiator: "auto",
        failureKind: "something_else",
      })}\n`,
      "utf8",
    );

    expect(readDeploySwitchState(path)).toBeNull();
  });
});
