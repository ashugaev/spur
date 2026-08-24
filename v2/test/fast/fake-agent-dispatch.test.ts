import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgentScript } from "../helpers/runtime.js";

// Pins the claude fake-agent read loop's dispatch semantics: a single-write
// burst that lands every line of a multi-line prompt plus a trailing
// `exit-now` inside the 0.5s drain window (v2/test/helpers/runtime.ts:475)
// must still dispatch on `exit-now`, not on the drained burst's first line.
// Before the fix the loop dispatched `case "$line"` (the first line), so a
// swallowed `exit-now` never ran and the fixture never exited.
describe("fakeAgentScript claude dispatch", () => {
  it("exits on exit-now even when the whole burst lands inside one drain window", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "fake-agent-dispatch-"));
    try {
      const scriptPath = join(tempDir, "claude");
      await writeFile(scriptPath, fakeAgentScript("claude"), "utf8");
      await chmod(scriptPath, 0o755);

      const child = spawn(scriptPath, [], {
        cwd: tempDir,
        env: {
          ...process.env,
          HOME: tempDir,
          SPUR_FAKE_AGENT_LOG_DIR: tempDir,
          SPUR_SESSION: "fake-agent-dispatch-test",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      const exitPromise = new Promise<number | null>((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (code) => resolvePromise(code));
      });

      // Worst case per the spec: every line of a multi-line prompt plus the
      // follow-up `exit-now` arrives in the SAME write, so the read loop's
      // drain (:475) absorbs all of it inside one 0.5s window.
      const multiLinePrompt = Array.from({ length: 20 }, (_, i) => `prompt line ${i}`).join("\n");
      child.stdin.write(`${multiLinePrompt}\nexit-now\n`);
      child.stdin.end();

      const exitCode = await Promise.race([
        exitPromise,
        new Promise<never>((_, rejectPromise) =>
          setTimeout(() => rejectPromise(new Error("fake agent did not exit within 5s")), 5000),
        ),
      ]);

      expect(exitCode).toBe(0);
      // The buggy first-line dispatch also exits 0 (stdin closes -> outer
      // read loop hits EOF -> script falls off the end), so exit code alone
      // is not enough to pin this: it must exit via the `exit-now` case arm,
      // never reaching the default arm's ack echo for the swallowed prompt.
      expect(stdout).not.toContain("ack:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
