import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionView } from "../../src/types.js";
import { execFileAsync, findFreePort, pollUntil } from "../helpers/common.js";
import {
  createRuntimeTestContext,
  isTmuxAvailable,
  killTmuxSessionsByPrefix,
  stopDaemonByPid,
  syncTmuxEnvironment,
  tmuxSessionExists,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

interface PsRow {
  pid: number;
  ppid: number;
  args: string;
}

async function psSnapshot(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]);
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? "" });
  }
  return rows;
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ReapPids {
  scriptPid: number;
  grandchildPid: number;
  marker: string;
}

async function readReapPids(path: string): Promise<ReapPids | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const [scriptLine, grandchildLine] = content.trim().split("\n");
  if (!scriptLine || !grandchildLine) return null;
  const scriptPid = Number.parseInt(scriptLine, 10);
  const grandchildPid = Number.parseInt(grandchildLine, 10);
  if (!Number.isInteger(scriptPid) || !Number.isInteger(grandchildPid)) return null;
  return { scriptPid, grandchildPid, marker: `reap-grandchild-${scriptPid}` };
}

const activeContexts: Array<{
  context: RuntimeTestContext;
  daemonPid?: number;
  sessionPrefix: string;
}> = [];

describe.skipIf(!tmuxOk)("sidecar reap (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = activeContexts.pop();
      if (!current) break;
      await stopDaemonByPid(current.daemonPid);
      await killTmuxSessionsByPrefix(current.sessionPrefix, current.context.tmuxSocketName);
      await current.context.cleanup();
    }
  });

  it("restart leaves nothing alive: a setsid grandchild is reaped, not reparented to init", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-reap-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    // Safety net: this suite's own afterEach only kills the tmux session
    // directly (bypassing Spur's reap), so any grandchild pid this test
    // records is force-killed on the way out regardless of how the test
    // ends — never leaked past this test file even on assertion failure.
    const knownGrandchildPids = new Set<number>();

    try {
      // A hostile sidecar: it does NOT trap or forward signals to its own
      // child. It `setsid`s a `sleep 3600` grandchild into a brand-new
      // process group/session (mirroring scripts/spur-isolated-ui.sh:102),
      // records both pids, then execs into `tail -f /dev/null` (keeping the
      // recorded $$ valid, since exec preserves the pid). A bare pane-group
      // SIGTERM only reaches this script's own pid — never the grandchild,
      // which lives in a DIFFERENT process group. Only the pre-signal
      // snapshot + ppid tree walk (v2/src/sidecars/reap.ts) can reach it.
      const sidecarPath = join(context.repoDir, "reap-sidecar.sh");
      await writeFile(
        sidecarPath,
        `#!/usr/bin/env bash
set -euo pipefail
setsid bash -c 'exec -a "reap-grandchild-'"$$"'" sleep 3600' &
GRANDCHILD_PID=$!
printf '%s\\n%s\\n' "$$" "$GRANDCHILD_PID" > ".reap-pids-\${SPUR_SESSION:?}"
exec tail -f /dev/null
`,
        "utf8",
      );
      await chmod(sidecarPath, 0o755);

      const configPath = await context.writeConfig(
        "sidecar-reap.yaml",
        `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      reap:
        command: "${sidecarPath}"
        autoStart: true
`,
      );
      const daemon = await context.startDaemon(configPath);
      const active = activeContexts.at(-1);
      if (!active) {
        throw new Error("Expected an active runtime context");
      }
      active.daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            "sidecar reap test",
            "--json",
          ])
        ).stdout,
      ) as SessionView;
      const reapTmuxSession = `${spawned.id}--reap`;
      await pollUntil(() => tmuxSessionExists(reapTmuxSession), {
        timeoutMs: 15_000,
        accept: (value) => value === true,
      });

      const pidsPath = join(spawned.worktreePath, `.reap-pids-${spawned.id}`);
      // pollUntil throws before returning null (accept rejects it), so this
      // cast is safe once the call resolves.
      const instance1 = (await pollUntil(() => readReapPids(pidsPath), {
        timeoutMs: 15_000,
        accept: (value): value is ReapPids => value !== null,
      })) as ReapPids;
      knownGrandchildPids.add(instance1.grandchildPid);
      expect(await processAlive(instance1.scriptPid)).toBe(true);
      expect(await processAlive(instance1.grandchildPid)).toBe(true);

      // Restart through the CLI: stop then start, exactly the operator path
      // `spur sidecar sweep`/dead-pane restart both rely on.
      await context.execCli([
        "--config",
        configPath,
        "sidecar",
        "stop",
        "--session",
        spawned.id,
        "--name",
        "reap",
      ]);
      await context.execCli([
        "--config",
        configPath,
        "sidecar",
        "start",
        "--session",
        spawned.id,
        "--name",
        "reap",
      ]);

      await pollUntil(() => tmuxSessionExists(reapTmuxSession), {
        timeoutMs: 15_000,
        accept: (value) => value === true,
      });
      const instance2 = (await pollUntil(
        async () => {
          const current = await readReapPids(pidsPath);
          if (!current || current.scriptPid === instance1.scriptPid) return null;
          return current;
        },
        { timeoutMs: 15_000, accept: (value): value is ReapPids => value !== null },
      )) as ReapPids;
      knownGrandchildPids.add(instance2.grandchildPid);

      // (a) both instance-1 pids are gone.
      expect(await processAlive(instance1.scriptPid)).toBe(false);
      expect(await processAlive(instance1.grandchildPid)).toBe(false);

      // (b) no surviving process anywhere carries the instance-1 marker.
      const snapshotAfter = await psSnapshot();
      const instance1MarkerRows = snapshotAfter.filter((row) =>
        row.args.includes(instance1.marker),
      );
      expect(instance1MarkerRows).toEqual([]);

      // (c) no surviving row reparented to init carries the instance-1
      // marker (a stricter subset of (b), stated explicitly per the
      // acceptance criterion — a reparented-but-unmatched row would still
      // be fine).
      const orphanedInstance1Rows = snapshotAfter.filter(
        (row) => row.ppid === 1 && row.args.includes(instance1.marker),
      );
      expect(orphanedInstance1Rows).toEqual([]);

      // (d) instance 2's pids differ and are alive.
      expect(instance2.scriptPid).not.toBe(instance1.scriptPid);
      expect(instance2.grandchildPid).not.toBe(instance1.grandchildPid);
      expect(await processAlive(instance2.scriptPid)).toBe(true);
      expect(await processAlive(instance2.grandchildPid)).toBe(true);

      // Stop instance 2 through the same CLI reap path — doubles as extra
      // coverage that the mechanism reaps a second, independently-spawned
      // tree, and leaves this test's own sidecar fully torn down before the
      // suite's own (non-reap-aware) afterEach runs.
      await context.execCli([
        "--config",
        configPath,
        "sidecar",
        "stop",
        "--session",
        spawned.id,
        "--name",
        "reap",
      ]);
      await pollUntil(() => processAlive(instance2.grandchildPid), {
        timeoutMs: 15_000,
        accept: (value) => value === false,
      });
      expect(await processAlive(instance2.scriptPid)).toBe(false);
      expect(await processAlive(instance2.grandchildPid)).toBe(false);
    } finally {
      for (const pid of knownGrandchildPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("the boot-time idle-TTL reap pass leaves a setsid grandchild with zero survivors", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-idle-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const knownGrandchildPids = new Set<number>();

    try {
      // Same hostile-sidecar shape as the setsid-grandchild test above
      // (the fork-ts-checker analogue): a bare pane-group signal can never
      // reach the grandchild's own process group.
      const sidecarPath = join(context.repoDir, "idle-reap-sidecar.sh");
      await writeFile(
        sidecarPath,
        `#!/usr/bin/env bash
set -euo pipefail
setsid bash -c 'exec -a "reap-grandchild-'"$$"'" sleep 3600' &
GRANDCHILD_PID=$!
printf '%s\\n%s\\n' "$$" "$GRANDCHILD_PID" > ".idle-reap-pids-\${SPUR_SESSION:?}"
exec tail -f /dev/null
`,
        "utf8",
      );
      await chmod(sidecarPath, 0o755);

      // idleTtlMinutes: 1 keeps this test's real-wall-clock wait bounded;
      // the sidecar declares no ports, so connections resolve to "none"
      // without any `ss` probe.
      const configPath = await context.writeConfig(
        "sidecar-idle-reap.yaml",
        `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
sidecarGc:
  enabled: true
  idleTtlMinutes: 1
  maxAgeWarnMinutes: 360
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    symlinks:
      - .env
    sidecars:
      idlereap:
        command: "${sidecarPath}"
        autoStart: true
`,
      );
      let daemon = await context.startDaemon(configPath);
      const active = activeContexts.at(-1);
      if (!active) {
        throw new Error("Expected an active runtime context");
      }
      active.daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            "sidecar idle reap test",
            "--json",
          ])
        ).stdout,
      ) as SessionView;
      const idleReapTmuxSession = `${spawned.id}--idlereap`;
      await pollUntil(() => tmuxSessionExists(idleReapTmuxSession), {
        timeoutMs: 15_000,
        accept: (value) => value === true,
      });

      const pidsPath = join(spawned.worktreePath, `.idle-reap-pids-${spawned.id}`);
      const instance = (await pollUntil(() => readReapPids(pidsPath), {
        timeoutMs: 15_000,
        accept: (value): value is ReapPids => value !== null,
      })) as ReapPids;
      knownGrandchildPids.add(instance.grandchildPid);
      expect(await processAlive(instance.scriptPid)).toBe(true);
      expect(await processAlive(instance.grandchildPid)).toBe(true);

      // Real wall-clock wait past the 1-minute idleTtlMinutes: no further
      // activity on this session after spawn, so its dashboard/updatedAt
      // clock genuinely ages past the TTL — no fake-timer shortcut exists
      // for a real daemon subprocess.
      await new Promise((resolve) => setTimeout(resolve, 70_000));

      // Restart the daemon process (tmux and the sidecar tree are
      // untouched by this — only the daemon's own process exits) to drive
      // the boot-time plan/execute pass without waiting a further 5
      // minutes for the interval tick.
      await stopDaemonByPid(active.daemonPid);
      daemon = await context.startDaemon(configPath);
      active.daemonPid = daemon.info.pid;

      await pollUntil(() => processAlive(instance.grandchildPid), {
        timeoutMs: 30_000,
        accept: (value) => value === false,
      });
      expect(await processAlive(instance.scriptPid)).toBe(false);
      expect(await processAlive(instance.grandchildPid)).toBe(false);

      const snapshotAfter = await psSnapshot();
      const markerRows = snapshotAfter.filter((row) => row.args.includes(instance.marker));
      expect(markerRows).toEqual([]);
    } finally {
      for (const pid of knownGrandchildPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 180_000);
});
