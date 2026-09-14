import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectOrphanedSidecarTrees } from "../../../src/session-service.js";
import * as reapModule from "../../../src/sidecars/reap.js";
import {
  snapshotProcesses,
  type ProcSnapshot,
  type SidecarClaim,
  type SidecarSweepClaims,
} from "../../../src/sidecars/reap.js";
import { createTempDir } from "../../helpers/common.js";

// Narrows `T | undefined` without a non-null assertion.
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function killGroupSafely(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe("detectOrphanedSidecarTrees", () => {
  let worktreeDir: string;
  let worktreePath: string;

  afterEach(async () => {
    if (worktreeDir) {
      await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Spawns a real detached process under a temp worktree, then builds a
  // snapshot from REAL `ps` data for it with `ppid` overridden to 1. This
  // sandbox's own init reparents an orphan to a local subreaper rather than
  // pid 1 directly, which would make the ppid===1 gate flaky against the
  // host's own process tree; the override isolates the test to exactly the
  // one condition findLeakedSidecarTrees gates on, without ever touching a
  // process this test didn't spawn.
  async function spawnOrphan(): Promise<{
    pid: number;
    child: ChildProcess;
    worktreePath: string;
    worktreeDir: string;
    snapshot: ProcSnapshot;
  }> {
    // Host safety: this test spawns and reaps only its OWN synthetic
    // process, never touches a real host session. A temp `dataDir`/
    // `worktreeDir` are the whole input — no daemon, no host config.
    const tmp = await createTempDir("spur-orphan-detect");
    worktreeDir = tmp;
    const wt = join(tmp, "worktrees", "api-1");
    await mkdir(wt, { recursive: true });
    worktreePath = realpathSync(wt);
    const child = spawn("bash", ["-c", "sleep 30"], {
      stdio: "ignore",
      detached: true,
      cwd: wt,
    });
    const pid = must(child.pid, "expected a spawned pid");
    await sleep(30);
    const real = await snapshotProcesses();
    const row = must(real.byPid.get(pid), "expected the spawned pid in the snapshot");
    const orphanRow = { ...row, ppid: 1 };
    const snapshot: ProcSnapshot = {
      ok: true,
      byPid: new Map([[pid, orphanRow]]),
      byPgid: new Map([[orphanRow.pgid, [orphanRow]]]),
    };
    return { pid, child, worktreePath, worktreeDir: realpathSync(tmp), snapshot };
  }

  // `process.kill(pid, 0)` alone is a weak liveness proof against a SIGKILLed
  // child THIS test process spawned: the kernel leaves it as a reapable
  // zombie (still answers signal 0) until this process's event loop
  // processes the exit. Waiting for the ChildProcess's own `exit` event (or
  // a bounded timeout if it never fires) is the real proof either way.
  async function stillRunning(child: ChildProcess): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      sleep(200).then(() => false),
    ]);
    return !exited;
  }

  // AC-b: an orphan tree under a RUNNING session (a live claim exists, but
  // the orphan's pgid is not among the claim's recorded livePgids — the
  // only shape Finding B1 leaves reachable) is detected and emitted.
  it("AC-b: emits session.sidecar.orphan_detected for an orphan not covered by any recorded claim", async () => {
    const { pid, child, worktreePath: wt, worktreeDir: wd, snapshot } = await spawnOrphan();
    try {
      const claim: SidecarClaim = {
        sidecarNames: new Set(["dev"]),
        livePgids: new Set([999999]), // never the orphan's own pgid
        identityRecorded: true,
      };
      const assembled: SidecarSweepClaims = {
        claims: new Map([[wt, claim]]),
        worktreePaths: [wt],
        worktreeDirRealpath: wd,
      };
      const logEvent = vi.fn();
      const leaked = await detectOrphanedSidecarTrees(snapshot, assembled, logEvent);
      expect(leaked.some((tree) => tree.rootPid === pid)).toBe(true);
      expect(logEvent).toHaveBeenCalledWith(
        "session.sidecar.orphan_detected",
        expect.objectContaining({
          details: expect.objectContaining({ rootPid: pid, worktreePath: wt }),
        }),
      );
      // Still alive — detection signals nothing (I10 / AC-c).
      expect(await stillRunning(child)).toBe(true);
    } finally {
      killGroupSafely(pid);
    }
  });

  // AC-b discriminator: dropping findLeakedSidecarTrees from the detection
  // step means no event is ever emitted for a real leaked tree.
  it("AC-b discriminator: emits nothing when findLeakedSidecarTrees is bypassed", async () => {
    const { pid, worktreePath: wt, worktreeDir: wd, snapshot } = await spawnOrphan();
    try {
      const assembled: SidecarSweepClaims = {
        claims: new Map(),
        worktreePaths: [wt],
        worktreeDirRealpath: wd,
      };
      const spy = vi.spyOn(reapModule, "findLeakedSidecarTrees").mockResolvedValue({
        supported: true,
        leaked: [],
      });
      const logEvent = vi.fn();
      const leaked = await detectOrphanedSidecarTrees(snapshot, assembled, logEvent);
      expect(leaked).toEqual([]);
      expect(logEvent).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      killGroupSafely(pid);
    }
  });

  // AC-c: the detection tick never signals anything. This is a real spawned
  // process (not a mock), so "still alive after the pass" is direct proof —
  // no signal call, blind or identity-gated, ran against it. Also asserts
  // the leak was actually seen (reapable: false, since the fixture's own
  // `bash -c` args name no sidecar), so a pass that silently skipped
  // detection could not make this test pass by doing nothing at all.
  it("AC-c: the detection tick never signals the tree it detects", async () => {
    const { pid, child, worktreePath: wt, worktreeDir: wd, snapshot } = await spawnOrphan();
    try {
      const assembled: SidecarSweepClaims = {
        claims: new Map(),
        worktreePaths: [wt],
        worktreeDirRealpath: wd,
      };
      const logEvent = vi.fn();
      const leaked = await detectOrphanedSidecarTrees(snapshot, assembled, logEvent);
      expect(leaked.some((tree) => tree.rootPid === pid)).toBe(true);
      expect(await stillRunning(child)).toBe(true);
    } finally {
      killGroupSafely(pid);
    }
  });
});
