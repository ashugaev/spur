import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { observationDeadline } from "../../src/observation-deadline.js";

const run = promisify(execFile);

describe("observation subprocess deadline", () => {
  it("kills and reaps an owned child that ignores SIGTERM", async () => {
    const child = run(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { timeout: 500, killSignal: "SIGKILL" },
    );
    const pid = child.child.pid;
    if (pid === undefined) throw new Error("Child did not start");
    const bounded = observationDeadline(child, 800);
    const outcome = expect(bounded).rejects.toThrow();
    const start = Date.now();
    if (!child.child.stdout) throw new Error("Child stdout unavailable");
    await once(child.child.stdout, "data");
    child.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(child.child.exitCode).toBeNull();
    expect(child.child.signalCode).toBeNull();
    await outcome;
    expect(Date.now() - start).toBeLessThan(2_000);
    await expect(child).rejects.toMatchObject({ signal: "SIGKILL" });
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
