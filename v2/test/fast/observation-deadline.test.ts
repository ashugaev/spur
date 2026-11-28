import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { observationDeadline } from "../../src/observation-deadline.js";

const run = promisify(execFile);

describe("observation subprocess deadline", () => {
  it("kills and reaps an owned child that ignores SIGTERM", async () => {
    // A shell ignores SIGTERM within milliseconds of spawn; a node child's
    // startup can outlast the 500ms timeout on a loaded runner.
    const child = run("sh", ["-c", "trap '' TERM; echo ready; exec sleep 30"], {
      timeout: 500,
      killSignal: "SIGKILL",
    });
    const pid = child.child.pid;
    if (pid === undefined) throw new Error("Child did not start");
    const bounded = observationDeadline(child, 800);
    const outcome = expect(bounded).rejects.toThrow();
    const start = Date.now();
    if (!child.child.stdout) throw new Error("Child stdout unavailable");
    const waiting = new AbortController();
    await Promise.race([
      once(child.child.stdout, "data", { signal: waiting.signal }),
      once(child.child, "exit", { signal: waiting.signal }).then(
        ([code, signal]: unknown[]) => {
          throw new Error(
            `Child exited before ready: code ${String(code)}, signal ${String(signal)}`,
          );
        },
        () => undefined,
      ),
    ]).finally(() => waiting.abort());
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
