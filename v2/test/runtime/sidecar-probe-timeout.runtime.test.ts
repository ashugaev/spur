import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionRecord, SessionView } from "../../src/types.js";
import { execFileAsync, findFreePort, pollUntil } from "../helpers/common.js";
import {
  createRuntimeTestContext,
  execTmux,
  isTmuxAvailable,
  killTmuxSessionsByPrefix,
  stopDaemonByPid,
  syncTmuxEnvironment,
  tmuxSessionExists,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

// Issue #899. The daemon's tmux() kills a probe after 5s; a killed probe is
// ambiguous, never proof of absence. These cases drive a REAL daemon against a
// REAL tmux server and make the daemon's own probes time out for real: a
// `tmux` shim first on the daemon's PATH parks chosen subcommands in
// `exec sleep`, so execFile's timeout SIGTERMs it exactly as it would a hung
// server. The test side calls tmux through the vitest process's own PATH and
// never meets the shim, so its observations are unaffected by the fault.
const REAL_TMUX = "/usr/bin/tmux";

function tmuxShim(faultDir: string): string {
  return `#!/usr/bin/env bash
sub=""
args=("$@")
i=0
while [ "$i" -lt "\${#args[@]}" ]; do
  case "\${args[$i]}" in
    -L|-S|-f) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) sub="\${args[$i]}"; break ;;
  esac
done
echo "$sub" >> "${faultDir}/calls.log"
if [ -n "$sub" ] && { [ -e "${faultDir}/hang-$sub" ] || mv "${faultDir}/hang-once-$sub" "${faultDir}/.claimed-$$" 2>/dev/null; }; then
  echo "HANG $sub" >> "${faultDir}/calls.log"
  exec sleep 60
fi
exec ${REAL_TMUX} "$@"
`;
}

// Each sidecar records its own pid in the worktree, then execs (exec keeps
// the pid), so "is the sidecar the probe could not see still alive" is a
// plain kill -0 against a pid the daemon never told us.
const DEV_SIDECAR = `#!/usr/bin/env bash
echo "$$" > ".pid-dev-\${SPUR_SESSION:?}"
exec sleep 3600
`;
// Ignores SIGHUP (an ignored disposition survives exec), so killing its tmux
// session leaves the process running with no supervisor — the recorded
// identity is then the only handle on it.
const ESCAPEE_SIDECAR = `#!/usr/bin/env bash
echo "$$" > ".pid-escapee-\${SPUR_SESSION:?}"
trap '' HUP
exec sleep 3600
`;
const WEB_SIDECAR = `#!/usr/bin/env bash
echo "$$" > ".pid-web-\${SPUR_SESSION:?}"
exec python3 -m http.server "\${SPUR_TEST_WEB_PORT:?}" --bind 127.0.0.1
`;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function httpOk(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!tmuxOk)("sidecar start under a timed-out tmux probe (runtime, #899)", () => {
  let context: RuntimeTestContext;
  let configPath: string;
  let daemonPid: number | undefined;
  let faultDir: string;
  let sessionPrefix: string;
  // Processes deliberately outliving their tmux session; force-killed on the
  // way out however the case ends, so a failed reap never leaks past the file.
  const escapeePids = new Set<number>();

  // The fleet probes are memoized for 2s from fetch start, so a start issued
  // right after arming a hang can legitimately answer from a snapshot tmux
  // gave moments earlier. Waiting past the TTL guarantees every read the
  // start makes either forks into the hang or joins an in-flight hung fetch.
  const hang = async (subcommand: string): Promise<void> => {
    await writeFile(join(faultDir, `hang-${subcommand}`), "", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  };
  const hangOnce = async (subcommand: string): Promise<void> => {
    await writeFile(join(faultDir, `hang-once-${subcommand}`), "", "utf8");
  };
  const clearFaults = async (): Promise<void> => {
    for (const sub of ["list-windows", "list-panes", "respawn-pane", "set-option"]) {
      await rm(join(faultDir, `hang-${sub}`), { force: true });
      await rm(join(faultDir, `hang-once-${sub}`), { force: true });
    }
  };
  const callsLog = async (): Promise<string[]> => {
    try {
      return (await readFile(join(faultDir, "calls.log"), "utf8")).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const resetCallsLog = async (): Promise<void> => {
    await writeFile(join(faultDir, "calls.log"), "", "utf8");
  };

  const spawnSession = async (title: string): Promise<SessionView> =>
    JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", title, "--json"])).stdout,
    ) as SessionView;

  const readRecord = async (sessionId: string): Promise<SessionRecord> =>
    JSON.parse(
      await readFile(join(context.dataDir, "sessions", "api", `${sessionId}.json`), "utf8"),
    ) as SessionRecord;

  const startSidecar = async (
    sessionId: string,
    name: string,
  ): Promise<{ status: number; body: string }> => {
    const response = await fetch(
      `http://127.0.0.1:${context.port}/sessions/${sessionId}/sidecars/${name}/start`,
      { method: "POST", signal: AbortSignal.timeout(90_000) },
    );
    return { status: response.status, body: await response.text() };
  };

  const readPid = async (session: SessionView, name: string): Promise<number> =>
    (await pollUntil(
      async () => {
        try {
          const text = await readFile(
            join(session.worktreePath, `.pid-${name}-${session.id}`),
            "utf8",
          );
          const pid = Number.parseInt(text.trim(), 10);
          return Number.isInteger(pid) ? pid : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 15_000, accept: (value) => value !== null, label: `${name} pid file` },
    )) as number;

  beforeAll(async () => {
    const port = await findFreePort();
    context = await createRuntimeTestContext(port);
    sessionPrefix = `rt-probe-${port}`;
    // fakeBinDir is `<context root>/bin`; everything this file writes lives
    // under that root, so context.cleanup() removes it and runs never share it.
    const rootDir = join(context.fakeBinDir, "..");
    faultDir = join(rootDir, "faults");
    await mkdir(faultDir, { recursive: true });
    await resetCallsLog();
    // Shadows the real tmux for the DAEMON only: fakeBinDir is first on the
    // daemon's PATH, never on this vitest process's.
    const shimPath = join(context.fakeBinDir, "tmux");
    await writeFile(shimPath, tmuxShim(faultDir), "utf8");
    await chmod(shimPath, 0o755);

    const devPath = join(rootDir, "dev-sidecar.sh");
    const webPath = join(rootDir, "web-sidecar.sh");
    const escapeePath = join(rootDir, "escapee-sidecar.sh");
    await writeFile(devPath, DEV_SIDECAR, "utf8");
    await writeFile(webPath, WEB_SIDECAR, "utf8");
    await writeFile(escapeePath, ESCAPEE_SIDECAR, "utf8");
    await chmod(devPath, 0o755);
    await chmod(webPath, 0o755);
    await chmod(escapeePath, 0o755);

    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    configPath = await context.writeConfig(
      "probe-timeout.yaml",
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
    sidecars:
      dev:
        command: "${devPath}"
        autoStart: false
      escapee:
        command: "${escapeePath}"
        autoStart: false
      web:
        command: "${webPath}"
        autoStart: false
        ports:
          http:
            env: SPUR_TEST_WEB_PORT
            start: 47100
            end: 47199
`,
    );
    const daemon = await context.startDaemon(configPath);
    daemonPid = daemon.info.pid;
  });

  afterAll(async () => {
    for (const pid of escapeePids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already reaped.
      }
    }
    await clearFaults().catch(() => undefined);
    await stopDaemonByPid(daemonPid);
    await killTmuxSessionsByPrefix(sessionPrefix, context.tmuxSocketName);
    await context.cleanup();
  });

  it("binds the daemon to loopback only", async () => {
    const { stdout } = await execFileAsync("ss", ["-tlnH"]);
    const listeners = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[3] ?? "")
      .filter((addr) => addr.endsWith(`:${context.port}`));
    expect(listeners.length).toBeGreaterThan(0);
    for (const addr of listeners) {
      expect(addr).toBe(`127.0.0.1:${context.port}`);
    }
  });

  it("session leg: a recorded live sidecar survives a timed-out session probe, and the start answers 503", async () => {
    const session = await spawnSession("probe session leg");
    expect((await startSidecar(session.id, "dev")).status).toBe(200);
    const pid = await readPid(session, "dev");
    // The recorded identity is the pane's own pid (the `sh -lc` wrapper), the
    // script's pid is its child — both must outlive the refusal.
    const identityBefore = (await readRecord(session.id)).sidecarProcs?.["dev"];
    expect(identityBefore).toBeDefined();
    const panePid = identityBefore?.pid as number;
    expect(processAlive(panePid)).toBe(true);

    await resetCallsLog();
    await hang("list-windows");
    const refused = await startSidecar(session.id, "dev");
    await clearFaults();

    // Soft: report every broken property, survival first — a status mismatch
    // alone must never hide whether the live sidecar was destroyed.
    expect(await callsLog()).toContain("HANG list-windows");
    expect.soft(processAlive(pid), "sidecar process survives").toBe(true);
    expect.soft(processAlive(panePid), "sidecar pane process survives").toBe(true);
    expect.soft(await tmuxSessionExists(`${session.id}--dev`), "tmux session survives").toBe(true);
    expect
      .soft((await readRecord(session.id)).sidecarProcs?.["dev"], "identity intact")
      .toEqual(identityBefore);
    expect.soft(await callsLog(), "no kill-session issued").not.toContain("kill-session");
    expect.soft(refused.status, "refusal status").toBe(503);
    expect.soft(refused.body, "refusal message").toContain("unreadable");

    // Retry once tmux answers again: a plain idempotent success on the same
    // instance, so the refusal left nothing behind (no conflict-gate entry,
    // no cleared identity) for the retry to trip over.
    const retried = await startSidecar(session.id, "dev");
    expect(retried.status, retried.body).toBe(200);
    expect(processAlive(pid)).toBe(true);
    expect(await readPid(session, "dev")).toBe(pid);
  });

  it("pane leg: a live pane survives a timed-out pane probe, and the start answers 503", async () => {
    const session = await spawnSession("probe pane leg");
    expect((await startSidecar(session.id, "dev")).status).toBe(200);
    const pid = await readPid(session, "dev");

    await resetCallsLog();
    await hang("list-panes");
    const refused = await startSidecar(session.id, "dev");
    await clearFaults();

    expect(await callsLog()).toContain("HANG list-panes");
    expect.soft(processAlive(pid), "sidecar process survives").toBe(true);
    expect.soft(await tmuxSessionExists(`${session.id}--dev`), "tmux session survives").toBe(true);
    expect.soft(await callsLog(), "no kill-session issued").not.toContain("kill-session");
    expect.soft(refused.status, "refusal status").toBe(503);
  });

  it("ported sidecar: a serving http sidecar keeps serving through a timed-out session probe", async () => {
    const session = await spawnSession("probe ported");
    expect((await startSidecar(session.id, "web")).status).toBe(200);
    const pid = await readPid(session, "web");
    const port = (await readRecord(session.id)).sidecarPorts?.["web"]?.["SPUR_TEST_WEB_PORT"];
    expect(port).toBeDefined();
    await pollUntil(() => httpOk(port as number), {
      timeoutMs: 15_000,
      accept: (ok) => ok,
      label: "web sidecar serving",
    });

    await resetCallsLog();
    await hang("list-windows");
    const outcome = await startSidecar(session.id, "web");
    await clearFaults();

    expect(await callsLog()).toContain("HANG list-windows");
    expect(await callsLog()).not.toContain("kill-session");
    expect([200, 503]).toContain(outcome.status);
    expect(processAlive(pid)).toBe(true);
    expect(await httpOk(port as number)).toBe(true);
    expect((await readRecord(session.id)).sidecarPorts?.["web"]?.["SPUR_TEST_WEB_PORT"]).toBe(port);
  });

  it("first start: nothing recorded, timed-out probe, tmux truly empty — the sidecar still launches", async () => {
    const session = await spawnSession("probe first start");
    await resetCallsLog();
    await hang("list-windows");
    const started = await startSidecar(session.id, "dev");
    await clearFaults();

    expect(await callsLog()).toContain("HANG list-windows");
    expect(started.status).toBe(200);
    const pid = await readPid(session, "dev");
    expect(processAlive(pid)).toBe(true);
    expect(await tmuxSessionExists(`${session.id}--dev`)).toBe(true);
  });

  it("first start: the tmux name is held by a live pane the probe cannot see — that pane survives", async () => {
    const session = await spawnSession("probe held name");
    const heldName = `${session.id}--dev`;
    await execTmux(["new-session", "-d", "-s", heldName, "sleep 3600"]);
    const heldPid = Number.parseInt(
      (await execTmux(["display-message", "-p", "-t", `=${heldName}:`, "#{pane_pid}"])).stdout,
      10,
    );
    expect(processAlive(heldPid)).toBe(true);

    await resetCallsLog();
    await hang("list-windows");
    const outcome = await startSidecar(session.id, "dev");
    await clearFaults();

    expect(await callsLog()).toContain("HANG list-windows");
    expect.soft(processAlive(heldPid), "held pane process survives").toBe(true);
    expect.soft(await tmuxSessionExists(heldName), "held tmux session survives").toBe(true);
    expect.soft(await callsLog(), "no kill-session issued").not.toContain("kill-session");
    expect.soft(outcome.status, "launch onto a held name fails").toBeGreaterThanOrEqual(400);
    await execTmux(["kill-session", "-t", `=${heldName}`]).catch(() => undefined);
  });

  it.each(["respawn-pane", "set-option"])(
    "created then failed: new-session lands, %s times out — the half-made pane is reaped and the next start recovers",
    async (postStep) => {
      const session = await spawnSession(`probe created then failed ${postStep}`);
      const paneName = `${session.id}--web`;

      // The reviewer's exact shape: the pre-launch probe is unreadable too, so
      // a skip keyed on that probe (instead of on what new-session created)
      // would keep the pane and wedge the sidecar.
      await resetCallsLog();
      await hang("list-windows");
      await hangOnce(postStep);
      const failed = await startSidecar(session.id, "web");
      await clearFaults();

      const calls = await callsLog();
      expect(calls).toContain("HANG list-windows");
      expect(calls, `${failed.body}\n${calls.join("\n")}`).toContain(`HANG ${postStep}`);
      expect(calls.indexOf("new-session")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("new-session")).toBeLessThan(calls.indexOf(`HANG ${postStep}`));
      expect.soft(failed.status, "launch failure surfaces").toBeGreaterThanOrEqual(400);
      expect.soft(await tmuxSessionExists(paneName), "half-made pane reaped").toBe(false);

      const recovered = await startSidecar(session.id, "web");
      expect.soft(recovered.status, "next start succeeds").toBe(200);
      const port = (await readRecord(session.id)).sidecarPorts?.["web"]?.["SPUR_TEST_WEB_PORT"];
      expect(port, "port reserved after recovery (no wedge)").toBeDefined();
      await pollUntil(() => httpOk(port as number), {
        timeoutMs: 15_000,
        accept: (ok) => ok,
        label: "web sidecar serving after recovery",
      });
    },
  );

  it("regression: with tmux answering, a recorded escapee whose tmux session is gone is still reaped", async () => {
    const session = await spawnSession("probe escapee reap");
    expect((await startSidecar(session.id, "escapee")).status).toBe(200);
    const escapeePid = await readPid(session, "escapee");
    escapeePids.add(escapeePid);
    await execTmux(["kill-session", "-t", `=${session.id}--escapee`]);
    await pollUntil(() => tmuxSessionExists(`${session.id}--escapee`), {
      timeoutMs: 10_000,
      accept: (exists) => !exists,
      label: "escapee tmux session gone",
    });
    // Precondition: the process outlived its supervisor. Without it this case
    // proves nothing about the reap.
    expect(processAlive(escapeePid)).toBe(true);
    await rm(join(session.worktreePath, `.pid-escapee-${session.id}`), { force: true });
    // Past the 2s fleet-snapshot TTL, so the start sees the session as gone
    // (the `!alive` leg) rather than a stale "present" paired with a fresh
    // pane read that finds nothing.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect((await startSidecar(session.id, "escapee")).status).toBe(200);
    const relaunchedPid = await readPid(session, "escapee");
    // The relaunch ignores SIGHUP too, so the tmux teardown in afterAll would
    // leave it running.
    escapeePids.add(relaunchedPid);
    expect(relaunchedPid).not.toBe(escapeePid);
    expect(processAlive(relaunchedPid)).toBe(true);
    await pollUntil(async () => !processAlive(escapeePid), {
      timeoutMs: 10_000,
      accept: (gone) => gone,
      label: "recorded escapee reaped",
    });
  });

  it("regression: with tmux answering, a dead pane is still reaped and relaunched", async () => {
    const session = await spawnSession("probe dead pane");
    expect((await startSidecar(session.id, "dev")).status).toBe(200);
    const firstPid = await readPid(session, "dev");
    process.kill(firstPid, "SIGKILL");
    await pollUntil(async () => !processAlive(firstPid), {
      timeoutMs: 10_000,
      accept: (gone) => gone,
      label: "first dev instance exits",
    });
    await rm(join(session.worktreePath, `.pid-dev-${session.id}`), { force: true });

    expect((await startSidecar(session.id, "dev")).status).toBe(200);
    const secondPid = await readPid(session, "dev");
    expect(secondPid).not.toBe(firstPid);
    expect(processAlive(secondPid)).toBe(true);
  });

  it("the CLI surfaces the refusal as a failed command with the retry message", async () => {
    const session = await spawnSession("probe cli");
    expect((await startSidecar(session.id, "dev")).status).toBe(200);
    const pid = await readPid(session, "dev");

    await resetCallsLog();
    await hang("list-windows");
    const result = await context
      .execCli(
        ["--config", configPath, "sidecar", "start", "--session", session.id, "--name", "dev"],
        { timeoutMs: 90_000 },
      )
      .then(
        () => ({ failed: false, stderr: "" }),
        (error: { stderr?: string }) => ({ failed: true, stderr: error.stderr ?? "" }),
      );
    await clearFaults();

    expect(await callsLog()).toContain("HANG list-windows");
    expect(result.failed).toBe(true);
    expect(result.stderr).toContain("retry shortly");
    expect(processAlive(pid)).toBe(true);
  });

  it("agent sessions stay running through every hang window", async () => {
    const views = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    const records = await Promise.all(views.map((view) => readRecord(view.id)));
    expect(records.length).toBeGreaterThanOrEqual(7);
    for (const record of records) {
      expect(record.status).toBe("running");
    }
  });
});
