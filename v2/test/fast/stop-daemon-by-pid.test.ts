import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { processExists, sleep } from "../helpers/common.js";
import { stopDaemonByPid } from "../helpers/runtime.js";

// Regression guard for the runtime-teardown race: stopDaemonByPid must await the
// process's actual exit before returning, not fire-and-forget a SIGTERM. A
// fire-and-forget teardown lets a still-shutting-down daemon hold its port /
// keep writing rootDir into the next test, causing order-dependent flake.

async function spawnLongLived(script: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Failed to spawn child process");
  }
  child.unref();
  // Give the interpreter a moment to install its SIGTERM handler before we
  // start signalling it.
  await sleep(100);
  return pid;
}

describe("stopDaemonByPid", () => {
  it("awaits the process exit before returning", async () => {
    const pid = await spawnLongLived("setInterval(() => {}, 1000)");
    expect(await processExists(pid)).toBe(true);

    await stopDaemonByPid(pid);

    expect(await processExists(pid)).toBe(false);
  });

  it("resolves without throwing when pid is undefined", async () => {
    await expect(stopDaemonByPid(undefined)).resolves.toBeUndefined();
  });
});
