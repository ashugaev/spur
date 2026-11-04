import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
    const held = join(home, "held");
    const go = join(home, "go");
    const holder = spawn(
      "flock",
      [
        "-s",
        lockPath,
        "bash",
        "-c",
        `touch ${JSON.stringify(held)}; until [ -e ${JSON.stringify(go)} ]; do sleep 0.05; done`,
      ],
      { stdio: "ignore" },
    );
    // acquireUpdateLock blocks the event loop, so a separate process releases the hold.
    let releaser: ChildProcess | undefined;
    const exits = (child: ChildProcess): Promise<void> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(held)) {
        if (Date.now() > deadline) throw new Error("holder never took the lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      releaser = spawn("bash", ["-c", `sleep 0.3; touch ${JSON.stringify(go)}`], {
        stdio: "ignore",
      });

      releases.push(acquireUpdateLock(home, 5));
    } finally {
      writeFileSync(go, "");
      await Promise.all([exits(holder), releaser ? exits(releaser) : Promise.resolve()]);
      await rm(home, { recursive: true, force: true });
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
