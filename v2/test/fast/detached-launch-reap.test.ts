import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/process-tree.js";
import { terminateDetachedSessionProcesses } from "../../src/agent-processes.js";

// Real /proc boundary: detached (setsid) children carrying Spur markers.
// Only children this test spawned are ever signalled; markers use random ids.
const rand = () => randomBytes(8).toString("hex");

function spawnDetached(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  child.unref();
  return child;
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!(await isPidAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe.runIf(process.platform === "linux")(
  "terminateDetachedSessionProcesses (real /proc)",
  () => {
    const spawned: ChildProcess[] = [];
    afterEach(() => {
      for (const child of spawned.splice(0)) {
        if (child.pid !== undefined) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    });

    it("kills the marked detached child and leaves sidecar and other-instance controls", async () => {
      const sessionId = `spur-${rand()}`;
      const toolDir = `/tmp/${rand()}/session-tools/${sessionId}`;
      const target = spawnDetached({
        SPUR_SESSION: sessionId,
        SPUR_SESSION_TOOL_DIR: toolDir,
        SPUR_AGENT_LAUNCH_ID: rand(),
      });
      const sidecar = spawnDetached({
        SPUR_SESSION: sessionId,
        SPUR_SESSION_TOOL_DIR: toolDir,
        SPUR_AGENT_LAUNCH_ID: "",
      });
      const otherInstance = spawnDetached({
        SPUR_SESSION: sessionId,
        SPUR_SESSION_TOOL_DIR: `/tmp/${rand()}/session-tools/${sessionId}`,
        SPUR_AGENT_LAUNCH_ID: rand(),
      });
      spawned.push(target, sidecar, otherInstance);
      const targetPid = target.pid;
      expect(targetPid).toBeGreaterThan(0);
      // Let each child's exec finish so /proc environ reflects the target env.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const outcome = await terminateDetachedSessionProcesses(
        { sessionId, sessionToolDir: toolDir, tmuxServerPid: null },
        { hupGraceMs: 2_000, termGraceMs: 2_000, killGraceMs: 2_000 },
      );

      expect(outcome).toEqual({ status: "clear" });
      expect(await waitDead(targetPid as number)).toBe(true);
      expect(await isPidAlive(sidecar.pid as number)).toBe(true);
      expect(await isPidAlive(otherInstance.pid as number)).toBe(true);
    });
  },
);
