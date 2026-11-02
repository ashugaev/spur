import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireUpdateLock } from "../../src/update.js";

// Real `flock`, no mocks: the lock must hold after the helper child exits and
// must exclude the blocking waiter install-and-restart.sh uses.
describe("acquireUpdateLock", () => {
  const releases: Array<() => void> = [];

  afterEach(() => {
    while (releases.length > 0) releases.pop()?.();
  });

  async function lockDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "spur-update-lock-"));
  }

  function otherHolderExitCode(home: string): number | null {
    return spawnSync("flock", [
      "--nonblock",
      join(home, ".spur", "install-and-restart.lock"),
      "-c",
      "true",
    ]).status;
  }

  it("holds the lock until release and excludes other holders", async () => {
    const home = await lockDir();
    releases.push(acquireUpdateLock(home));

    expect(otherHolderExitCode(home)).not.toBe(0);

    releases.pop()?.();
    expect(otherHolderExitCode(home)).toBe(0);
  });

  it("refuses a second acquisition while one is held", async () => {
    const home = await lockDir();
    releases.push(acquireUpdateLock(home));

    expect(() => acquireUpdateLock(home, 0.2)).toThrow("another Spur update is already running");
  });

  it("waits out a short shared hold instead of failing at once", async () => {
    const home = await lockDir();
    const lockPath = join(home, ".spur", "install-and-restart.lock");
    mkdirSync(join(home, ".spur"), { recursive: true });
    const holder = spawn("flock", ["-s", lockPath, "sleep", "0.5"], { stdio: "ignore" });
    try {
      const deadline = Date.now() + 10_000;
      while (spawnSync("flock", ["-n", "-x", lockPath, "true"]).status === 0) {
        if (Date.now() > deadline) throw new Error("holder never took the lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      releases.push(acquireUpdateLock(home, 5));
    } finally {
      holder.kill();
    }
  });

  it("makes a bounded waiter give up instead of hanging", async () => {
    const home = await lockDir();
    releases.push(acquireUpdateLock(home));

    const waiter = spawnSync("flock", [
      "--wait",
      "1",
      join(home, ".spur", "install-and-restart.lock"),
      "-c",
      "true",
    ]);
    expect(waiter.status).not.toBe(0);
  });
});
