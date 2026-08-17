import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
    });

    expect(reconcileDeploySwitchState(path)?.phase).toBe("running");

    writeDeploySwitchState(path, {
      phase: "running",
      version: "1.2.3",
      pid: process.pid,
      processStartTime: `${processStartTime}-reused`,
      startedAt: "2026-08-12T00:00:00Z",
    });
    expect(reconcileDeploySwitchState(path)).toEqual(
      expect.objectContaining({ phase: "failed", exitCode: -1 }),
    );
  });
});
