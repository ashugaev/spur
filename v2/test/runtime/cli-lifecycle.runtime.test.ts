import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toCursorProjectPath } from "../../src/cursor-jsonl-state.js";
import { readEventLog, type SpurLogEntry } from "../../src/event-log.js";
import { readSession, writeSession } from "../../src/metadata.js";
import { listProcesses, readProcessEnvValue } from "../../src/process-tree.js";
import type {
  RuntimeInfo,
  ServiceInstanceView,
  SidecarPortConflictPayload,
  SessionListItemView,
  SessionRecord,
  SessionView,
  TodoProjection,
} from "../../src/types.js";
import { execFileAsync, findFreePort, pollUntil, processExists, sleep } from "../helpers/common.js";
import {
  CLI_PATH,
  captureTmuxPane,
  createGitRepo,
  createRuntimeTestContext,
  createTmuxSession,
  execTmux,
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  readTmuxStatus,
  sendKeysToTmux,
  stopDaemonByPid,
  syncTmuxEnvironment,
  tmuxSessionExists,
  waitForCleanTodoLedger,
  type RuntimeTestContext,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

interface DoctorResult {
  hostChecks: Array<{
    id: string;
    ok: boolean;
    severity: "error" | "warn" | "info";
    detail: string;
    fix?: string;
  }>;
  configPath?: string;
  defaultBranch?: string;
  projectId?: string;
  sessionPrefix?: string;
  existingProjectConfigPath?: string;
}

// `doctor`'s host checks read host-global state that a temp `HOME` cannot
// isolate. The daemon port comes from the pinned instance config, but the web
// port does not: `readWebPort` parses `Environment=PORT=` out of the user's
// `spur-web.service` unit file and falls back to 5555 when that file is absent
// — it never consults `ui.port`. On a shared self-hosted runner another user's
// service legitimately holds 5555, and if its `/` does not answer inside the
// 2s probe window (CI load is enough), `checkServiceHealth` emits
// `web-port-conflict` at `error` severity and the CLI exits 1. Same documented
// collision class as the daemon's default 4310.
//
// So exit code is not a usable signal for the scaffolding invariants these
// tests own. Parse stdout and assert on the specific check under test instead;
// a genuinely crashed `doctor` prints no JSON and still fails here.
async function runDoctorJson(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ doctor: DoctorResult; exitCode: number }> {
  let stdout: string;
  let exitCode: number;
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      ...options,
      timeout: 60_000,
    });
    stdout = result.stdout;
    exitCode = 0;
  } catch (error) {
    const execError = error as { stdout?: string; code?: number };
    stdout = execError.stdout ?? "";
    exitCode = execError.code ?? 1;
  }
  try {
    return { doctor: JSON.parse(stdout) as DoctorResult, exitCode };
  } catch (error) {
    throw new Error(`Expected doctor JSON output, received: ${stdout}`, { cause: error });
  }
}

const activeContexts: Array<{
  context: RuntimeTestContext;
  daemonPid?: number;
  sessionPrefix: string;
  controllerSessionName?: string;
}> = [];

function currentActiveContext(): (typeof activeContexts)[number] {
  const current = activeContexts.at(-1);
  if (!current) {
    throw new Error("Expected an active runtime context");
  }
  return current;
}

function popActiveContext(): (typeof activeContexts)[number] {
  const current = activeContexts.pop();
  if (!current) {
    throw new Error("Expected an active runtime context to clean up");
  }
  return current;
}

async function expectSidecarPortConflict(
  request: Promise<unknown>,
  expected: SidecarPortConflictPayload,
): Promise<void> {
  let caught: unknown;
  try {
    await request;
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) {
    throw new Error("Expected sidecar port conflict error");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(caught.message) as unknown;
  } catch {
    throw new Error(`Expected JSON sidecar port conflict payload: ${caught.message}`);
  }
  expect(payload).toEqual(expected);
}

function requireSessionRecord(dataDir: string, sessionId: string): SessionRecord {
  const session = readSession(dataDir, sessionId);
  if (!session) {
    throw new Error(`Expected persisted session record for ${sessionId}`);
  }
  return session;
}

function baseConfig(
  context: RuntimeTestContext,
  sessionPrefix: string,
  extraProjectYaml = "",
): string {
  return `server:
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
${extraProjectYaml}
`;
}

async function writeSidecarDepthRecorder(
  context: RuntimeTestContext,
  scriptName: string,
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_SIDECAR_DEPTH:-}" > ".sidecar-depth-\${SPUR_SIDECAR_NAME:?}-\${SPUR_SESSION:?}"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeSidecarPortRecorder(
  context: RuntimeTestContext,
  scriptName = "record-sidecar-port.sh",
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_RESERVED_PORT_DEV:-}" > ".sidecar-port-\${SPUR_SESSION:?}"
tail -f /dev/null
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeLongLivedSidecar(
  context: RuntimeTestContext,
  scriptName = "reboot-sidecar.sh",
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeSidecarHttpServer(
  context: RuntimeTestContext,
  scriptName = "sidecar-http-server.mjs",
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `import { createServer } from "node:http";

const port = Number.parseInt(process.env.SPUR_RESERVED_PORT_DEV ?? "", 10);
if (!Number.isInteger(port)) {
  process.exit(1);
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ready");
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
`,
    "utf8",
  );
  return scriptPath;
}

async function writeIsolatedDaemonSiblingProbe(
  context: RuntimeTestContext,
  scriptName = "isolated-daemon-sibling-probe.sh",
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
runtime_file="\${SPUR_SESSION_TOOL_DIR:?}/isolated-env.sh"
for _ in $(seq 1 30); do
  if [[ -f "$runtime_file" ]]; then
    break
  fi
  sleep 1
done
if [[ ! -f "$runtime_file" ]]; then
  exit 1
fi
set +e
list_status=1
for _ in $(seq 1 30); do
  "$SPUR_SESSION_TOOL_DIR/spur-isolated" list --json > ".sibling-isolated-list-\${SPUR_SESSION:?}"
  list_status=$?
  if [[ "$list_status" -eq 0 ]]; then
    break
  fi
  sleep 1
done
set -e
if [[ "$list_status" -ne 0 ]]; then
  exit 1
fi
printf '%s\n' "$runtime_file" > ".sibling-isolated-env-\${SPUR_SESSION:?}"
set +e
valid_status=1
for _ in $(seq 1 30); do
  "$SPUR_SESSION_TOOL_DIR/spur-isolated" branch check --project api feature/push-check-valid > ".sibling-isolated-branch-valid-\${SPUR_SESSION:?}" 2>&1
  valid_status=$?
  if [[ "$valid_status" -eq 0 ]]; then
    break
  fi
  sleep 1
done
"$SPUR_SESSION_TOOL_DIR/spur-isolated" branch check --project api Bad_Branch.Name > ".sibling-isolated-branch-invalid-\${SPUR_SESSION:?}" 2>&1
invalid_status=$?
set -e
printf '%s\n' "$valid_status" > ".sibling-isolated-branch-valid-status-\${SPUR_SESSION:?}"
printf '%s\n' "$invalid_status" > ".sibling-isolated-branch-invalid-status-\${SPUR_SESSION:?}"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeIsolatedDaemonDependencyProbe(
  context: RuntimeTestContext,
  scriptName = "isolated-daemon-dependency-probe.sh",
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
runtime_file="\${SPUR_SESSION_TOOL_DIR:?}/isolated-env.sh"
cat > "$runtime_file" <<ENVFILE
SPUR_ISOLATED_CONFIG="/tmp/spur-isolated-config.yaml"
SPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:4321"
ENVFILE
chmod 600 "$runtime_file"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeIsolatedUiDependencyProbe(
  context: RuntimeTestContext,
  scriptName = "isolated-ui-dependency-probe.sh",
): Promise<string> {
  const scriptPath = join(context.repoDir, scriptName);
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
runtime_file="\${SPUR_SESSION_TOOL_DIR:?}/isolated-env.sh"
for _ in $(seq 1 30); do
  if [[ -f "$runtime_file" ]]; then
    break
  fi
  sleep 1
done
test -f "$runtime_file"
printf '%s\n' "$runtime_file" > ".isolated-ui-env-\${SPUR_SESSION:?}"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeReservedPortSidecarConfig(
  context: RuntimeTestContext,
  options: {
    configName: string;
    sessionPrefix: string;
    serverPort: number;
    rangeStart: number;
    rangeEnd: number;
  },
): Promise<string> {
  await writeSidecarPortRecorder(context);
  return context.writeConfig(
    options.configName,
    `server:
  host: 127.0.0.1
  port: ${options.serverPort}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${options.sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      dev:
        command: "./record-sidecar-port.sh"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: ${options.rangeStart}
            end: ${options.rangeEnd}
`,
  );
}

function sidecarDepthPath(worktreePath: string, sessionId: string, sidecarName: string): string {
  return join(worktreePath, `.sidecar-depth-${sidecarName}-${sessionId}`);
}

function sidecarPortPath(worktreePath: string, sessionId: string): string {
  return join(worktreePath, `.sidecar-port-${sessionId}`);
}

function sessionSidecarHelperPath(context: RuntimeTestContext, sessionId: string): string {
  return join(context.dataDir, "session-tools", sessionId, "spur-sidecar");
}

async function installFakeDesktopNotifier(context: RuntimeTestContext): Promise<string> {
  const logPath = join(context.rootDir, "desktop-notify.log");
  const binary = process.platform === "darwin" ? "osascript" : "notify-send";
  await writeFile(
    join(context.fakeBinDir, binary),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`,
    "utf8",
  );
  await chmod(join(context.fakeBinDir, binary), 0o755);
  return logPath;
}

async function findConsecutiveFreePorts(): Promise<{ start: number; end: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const start = await findFreePort();
    if (start >= 65_535) {
      continue;
    }
    const probe = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const available = await new Promise<boolean>((resolve) => {
      probe.once("error", () => {
        resolve(false);
      });
      probe.listen(start + 1, "127.0.0.1", () => {
        probe.close((error) => {
          resolve(!error);
        });
      });
    });
    if (available) {
      return { start, end: start + 1 };
    }
  }
  throw new Error("Failed to find consecutive free TCP ports for runtime test");
}

async function listenOnAllInterfaces(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function runRestoreScenario(args: {
  agent?: "claude" | "codex" | "cursor";
  configName: string;
  stopMode?: "exit" | "pause";
  expectRestorePrompt?: boolean;
}): Promise<{
  context: RuntimeTestContext;
  restored: SessionView[];
  spawned: SessionView;
  pane: string;
}> {
  const port = await findFreePort();
  const context = await createRuntimeTestContext(port);
  const sessionPrefix = `rt-restore-${args.agent ?? "claude"}-${port}`;
  activeContexts.push({ context, sessionPrefix });
  await syncTmuxEnvironment({
    HOME: context.env.HOME,
    PATH: context.env.PATH,
    SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
    SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
  });
  const configPath = await context.writeConfig(args.configName, baseConfig(context, sessionPrefix));
  const daemon = await context.startDaemon(configPath);
  currentActiveContext().daemonPid = daemon.info.pid;

  const spawnArgs = ["--config", configPath, "spawn", "api", "restore runtime prompt"];
  if (args.agent) {
    spawnArgs.push("--agent", args.agent);
  }
  spawnArgs.push("--json");

  const spawned = JSON.parse((await context.execCli(spawnArgs)).stdout) as SessionView;
  const expectedResumeId =
    (args.agent ?? "claude") === "codex"
      ? `thread-${spawned.id}`
      : (args.agent ?? "claude") === "cursor"
        ? `chat-${spawned.id}`
        : (spawned.agentSessionId ?? `fake-claude-${spawned.id}`);
  const stopMode = args.stopMode ?? "exit";
  const expectRestorePrompt = args.expectRestorePrompt ?? true;
  const restorePrompt = "This session was restored after the agent exited.";
  const readyMarker = (args.agent ?? "claude") === "codex" ? "›" : "❯";

  if (stopMode === "pause") {
    const paused = JSON.parse(
      (await context.execCli(["--config", configPath, "pause", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(paused.status).toBe("stopped");
    expect(paused.runtimeAlive).toBe(false);
    expect(paused.workspaceExists).toBe(true);
  } else {
    // The fixture's read loop drains a multi-line paste for up to 500ms of
    // silence before treating it as one complete message. The daemon's
    // submit-ack wait only proves the initial prompt was *delivered*, not
    // that the fixture's drain window has closed — sending "exit-now" too
    // early lands inside that still-open window and gets silently
    // concatenated onto the initial prompt instead of matching the
    // `exit-now` case arm, so the fixture never exits and the state poll
    // below times out waiting for an "error" state that can never arrive.
    // Wait for the fixture's own "ack: <prompt>" echo, which only prints
    // once its case statement runs on the closed initial message.
    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ack: restore runtime prompt"),
    });
    await context.execCli(["--config", configPath, "send", spawned.id, "exit-now", "--json"]);
  }

  // A manual pause kills the tmux session outright (runtimeAlive false, status
  // "stopped"). An agent process exiting on its own leaves the tmux pane/session
  // alive with no matching agent process, which reconcileUnexpectedStop treats
  // as an unexpected crash (status "errored") rather than a clean stop — see
  // "fix(session): preserve agent exit errors".
  const expectedState = stopMode === "pause" ? "stopped" : "error";
  const expectedStatus = stopMode === "pause" ? "stopped" : "errored";
  const exited = await pollUntil(
    async () =>
      JSON.parse(
        (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
      ) as SessionView[],
    {
      timeoutMs: 45_000,
      accept: (value) =>
        value[0]?.state === expectedState &&
        value[0]?.runtimeAlive === (stopMode === "exit") &&
        value[0]?.status === expectedStatus,
    },
  );
  expect(exited[0]?.workspaceExists).toBe(true);

  if (args.agent) {
    await context.fetchJson(`/sessions/${spawned.id}/restore`, { method: "POST" });
  } else {
    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "r");
  }

  const restored = await pollUntil(
    async () =>
      JSON.parse(
        (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
      ) as SessionView[],
    {
      timeoutMs: 45_000,
      accept: (value) => value[0]?.state !== expectedState && value[0]?.runtimeAlive === true,
    },
  );
  if (!args.agent) {
    await sendKeysToTmux(`${sessionPrefix}-ui`, "q");
  }

  const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
    timeoutMs: 15_000,
    accept: (value) =>
      expectRestorePrompt
        ? value.includes(restorePrompt)
        : value.includes(readyMarker) && !value.includes(restorePrompt),
  });

  const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
    timeoutMs: 15_000,
    accept: (value) => value.includes(`startup:resume:${expectedResumeId}:`),
  });

  expect(log).toContain(`startup:resume:${expectedResumeId}:`);
  expect(restored[0]?.runtimeAlive).toBe(true);
  expect(existsSync(restored[0]?.worktreePath ?? "")).toBe(true);
  if (expectRestorePrompt) {
    expect(pane).toContain("Original task:");
  } else {
    expect(pane).not.toContain(restorePrompt);
  }

  return { context, restored, spawned, pane };
}

describe.skipIf(!tmuxOk)("Spur CLI lifecycle (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = popActiveContext();
      await stopDaemonByPid(current.daemonPid);
      if (current.controllerSessionName) {
        await killTmuxSession(current.controllerSessionName);
      }
      await killTmuxSessionsByPrefix(current.sessionPrefix, current.context.tmuxSocketName);
      await current.context.cleanup();
    }
  });

  it.each(["list", "ls"])(
    "auto-starts the daemon for %s --json and returns an empty array",
    async (command) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-auto-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig("auto.yaml", baseConfig(context, sessionPrefix));

      const { stdout } = await context.execCli(["--config", configPath, command, "--json"]);
      const sessions = JSON.parse(stdout) as SessionView[];
      const info = await context.fetchJson<RuntimeInfo>("/info");
      currentActiveContext().daemonPid = info.pid;

      expect(sessions).toEqual([]);
      expect(info.host).toBe("127.0.0.1");
      expect(info.port).toBe(port);
    },
  );

  it("doctor writes a local config and list --json auto-connects it", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-doctor-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor } = await runDoctorJson(["doctor", "--json", "--scaffold"], {
      cwd: context.repoDir,
      env: doctorEnv,
    });

    expect(doctor.projectId).toMatch(/^spur-runtime-repo-/);
    expect(doctor.defaultBranch).toBe("main");
    expect(await readFile(join(context.repoDir, "spur.yaml"), "utf8")).toContain(
      `  ${doctor.projectId}:`,
    );

    const listRun = await execFileAsync(process.execPath, [CLI_PATH, "list", "--json"], {
      cwd: context.repoDir,
      env: doctorEnv,
      timeout: 60_000,
    });
    let sessions: SessionView[];
    try {
      sessions = JSON.parse(listRun.stdout) as SessionView[];
    } catch (error) {
      throw new Error(`Expected list JSON output, received: ${listRun.stdout}`, {
        cause: error,
      });
    }

    const info = await context.fetchJson<RuntimeInfo>("/info");
    currentActiveContext().daemonPid = info.pid;
    const projects = await context.fetchJson<Array<{ id: string }>>("/projects");

    expect(sessions).toEqual([]);
    expect(projects.map((project) => project.id)).toContain(doctor.projectId);
  });

  it("doctor scaffolds at the git repo root from nested directories without creating global config", async () => {
    const context = await createRuntimeTestContext(await findFreePort());
    const sessionPrefix = `rt-doctor-nested-${context.port}`;
    activeContexts.push({ context, sessionPrefix });
    const nestedDir = join(context.repoDir, "packages", "service");
    const globalConfigPath = join(context.env.HOME ?? context.rootDir, ".spur", "config.yaml");
    await mkdir(nestedDir, { recursive: true });
    // Pin an isolated instance config at a free port instead of relying on the
    // ambient-HOME auto-bootstrap default (4310) — the new daemon health probe
    // (F6) would otherwise cross-talk with a real daemon already bound to that
    // port on a shared host, matching the documented self-hosted-CI collision
    // class.
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${await findFreePort()}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor } = await runDoctorJson(["doctor", "--json", "--scaffold"], {
      cwd: nestedDir,
      env: doctorEnv,
    });

    expect(doctor.configPath).toBe(join(context.repoDir, "spur.yaml"));
    expect(doctor.projectId).toMatch(/^spur-runtime-repo-/);
    expect(existsSync(join(nestedDir, "spur.yaml"))).toBe(false);
    expect(existsSync(globalConfigPath)).toBe(false);
    expect(await readFile(join(context.repoDir, "spur.yaml"), "utf8")).toContain(
      `  ${doctor.projectId}:`,
    );
  });

  it("doctor reports existing local config without overwriting it", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-doctor-existing-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const existingConfig = ["projects:", "  existing:", "    path: .", ""].join("\n");
    await writeFile(join(context.repoDir, "spur.yaml"), existingConfig, "utf8");
    // Pin an isolated instance config so the new daemon health probe (F6)
    // never cross-talks with a real daemon bound to the ambient default port
    // on a shared host (same self-hosted-CI collision class as above).
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${await findFreePort()}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor } = await runDoctorJson(["doctor", "--json"], {
      cwd: context.repoDir,
      env: doctorEnv,
    });

    expect(doctor.existingProjectConfigPath).toBe(join(context.repoDir, "spur.yaml"));
    expect(doctor.hostChecks.length).toBeGreaterThan(0);
    expect(doctor.hostChecks.some((check) => check.id === "project-config-valid" && check.ok)).toBe(
      true,
    );
    expect(await readFile(join(context.repoDir, "spur.yaml"), "utf8")).toBe(existingConfig);
  });

  // Proves the `checkConfigRegistry` push (host-install.ts) is scoped inside
  // the `instanceConfig.status === "ok" && unitsInstalled` block: a host that
  // never ran `spur init` (no systemd units here) must not surface it.
  it("doctor omits config-registry on a host without systemd units", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-doctor-no-units-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${await findFreePort()}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor } = await runDoctorJson(["doctor", "--json"], {
      cwd: context.repoDir,
      env: doctorEnv,
    });

    expect(doctor.hostChecks.length).toBeGreaterThan(0);
    expect(doctor.hostChecks.every((check) => check.id !== "config-registry")).toBe(true);
  });

  // Guards the `runDoctorJson` tolerance above: a host-global port conflict is
  // error-severity, so `doctor` exits 1 while its report is perfectly valid on
  // stdout. Squats the pinned daemon port with a 500-answering server, which is
  // the same branch (`portConflictCheck`) the runner hits on port 5555 — but
  // driven by a port this test owns, so it never touches host state. Reverting
  // any doctor test to a bare `await execFileAsync` fails here.
  it("doctor still reports its config findings when a host port conflict forces a non-zero exit", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-doctor-port-conflict-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const existingConfig = ["projects:", "  existing:", "    path: .", ""].join("\n");
    await writeFile(join(context.repoDir, "spur.yaml"), existingConfig, "utf8");
    const squatPort = await findFreePort();
    const squatter = createServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((resolve) => {
      squatter.listen(squatPort, "127.0.0.1", resolve);
    });
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${squatPort}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );

    try {
      const { doctor, exitCode } = await runDoctorJson(["doctor", "--json"], {
        cwd: context.repoDir,
        env: { ...context.env, SPUR_CONFIG: instanceConfigPath },
      });

      expect(exitCode).toBe(1);
      expect(doctor.hostChecks.find((check) => check.id === "daemon-port-conflict")).toMatchObject({
        ok: false,
        severity: "error",
      });
      expect(doctor.existingProjectConfigPath).toBe(join(context.repoDir, "spur.yaml"));
      expect(
        doctor.hostChecks.some((check) => check.id === "project-config-valid" && check.ok),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        squatter.close(() => resolve());
      });
    }
  });

  it("doctor --json without --scaffold never creates spur.yaml or the global/pinned instance config on a never-initialized host", async () => {
    const context = await createRuntimeTestContext(await findFreePort());
    const sessionPrefix = `rt-doctor-readonly-${context.port}`;
    activeContexts.push({ context, sessionPrefix });
    const globalConfigPath = join(context.env.HOME ?? context.rootDir, ".spur", "config.yaml");
    // Unlike the other doctor tests, deliberately do NOT pre-create the
    // pinned instance config — this is the exact never-run-Spur-before
    // scenario the read-only invariant guards, so `SPUR_CONFIG` must point at
    // a path that does not exist yet.
    const instanceConfigPath = join(context.rootDir, "never-created-instance.yaml");
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor } = await runDoctorJson(["doctor", "--json"], {
      cwd: context.repoDir,
      env: doctorEnv,
    });

    expect(doctor.configPath).toBeUndefined();
    expect(doctor.existingProjectConfigPath).toBeUndefined();
    expect(existsSync(join(context.repoDir, "spur.yaml"))).toBe(false);
    expect(existsSync(globalConfigPath)).toBe(false);
    expect(existsSync(instanceConfigPath)).toBe(false);
  });

  it("doctor reports project-config-valid ok:false and a non-zero exit for a malformed spur.yaml, without throwing", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-doctor-malformed-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await writeFile(join(context.repoDir, "spur.yaml"), "projects: [\n", "utf8");
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${await findFreePort()}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor, exitCode } = await runDoctorJson(["doctor", "--json"], {
      cwd: context.repoDir,
      env: doctorEnv,
    });

    expect(exitCode).toBe(1);
    expect(doctor.hostChecks.find((check) => check.id === "project-config-valid")).toMatchObject({
      ok: false,
      severity: "error",
    });
  });

  // Group D full-process crossing: the fast `workspace.test.ts` tests cover
  // `checkProjectWorkspace`'s composition logic directly; this is the one
  // real CLI invocation confirming `cli.ts` actually wires it up end-to-end
  // (loop over `loadProjectConfig`'s previously-discarded return value)
  // without the process throwing.
  it("doctor reports a missing project path as a distinct error and a non-zero exit, without throwing", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-doctor-project-path-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await writeFile(
      join(context.repoDir, "spur.yaml"),
      ["projects:", "  gone:", "    path: /spur-doctor-runtime-test-gone-path", ""].join("\n"),
      "utf8",
    );
    const instanceConfigPath = await context.writeConfig(
      "doctor-instance.yaml",
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${await findFreePort()}`,
        `dataDir: ${context.dataDir}`,
        `worktreeDir: ${context.worktreeDir}`,
        "defaultAgent: claude",
        "",
      ].join("\n"),
    );
    const doctorEnv = {
      ...context.env,
      SPUR_CONFIG: instanceConfigPath,
    };

    const { doctor, exitCode } = await runDoctorJson(["doctor", "--json"], {
      cwd: context.repoDir,
      env: doctorEnv,
    });

    expect(exitCode).toBe(1);
    expect(
      doctor.hostChecks.find((check) => check.id === "project-path-exists:gone"),
    ).toMatchObject({
      ok: false,
      severity: "error",
    });
  });

  it("stops the daemon through the built CLI and keeps stop as a no-op once it is down", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-daemon-stop-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "daemon-stop.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const stopped = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "stop", "--json"])).stdout,
    ) as { baseUrl: string; pid?: number; stopped: boolean };

    expect(stopped.stopped).toBe(true);
    expect(stopped.pid).toBe(daemon.info.pid);
    delete currentActiveContext().daemonPid;
    await expect(context.fetchJson("/info")).rejects.toThrow();

    const noop = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "stop", "--json"])).stdout,
    ) as { baseUrl: string; pid?: number; stopped: boolean };

    expect(noop).toEqual({
      baseUrl: `http://127.0.0.1:${port}`,
      stopped: false,
    });
    await expect(context.fetchJson("/info")).rejects.toThrow();
  });

  it("exits on SIGTERM well inside the service-manager stop timeout", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-daemon-sigterm-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "daemon-sigterm.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    // The production hang: systemd sends SIGTERM, the daemon never finishes
    // teardown, and SIGKILL lands at TimeoutStopSec=90s. Signal the process
    // directly — the CLI stop path is already covered above.
    const startedAt = Date.now();
    process.kill(daemon.info.pid, "SIGTERM");
    await pollUntil(async () => !(await processExists(daemon.info.pid)), {
      timeoutMs: 30_000,
      accept: (exited) => exited,
      label: "daemon exit after SIGTERM",
    });
    const elapsedMs = Date.now() - startedAt;
    delete currentActiveContext().daemonPid;

    // Budget is 45s with a 60s backstop, under a 90s TimeoutStopSec. A healthy
    // teardown finishes in well under a second; 15s only guards against the
    // regression, so a loaded runner cannot turn this into a flake.
    expect(elapsedMs).toBeLessThan(15_000);
    await expect(context.fetchJson("/info")).rejects.toThrow();

    const events = readEventLog(context.dataDir).map((entry: SpurLogEntry) => entry.event);
    expect(events).toContain("daemon.stopped");
    expect(events).not.toContain("daemon.shutdown.forced_exit");
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "sends one desktop notification when a live session transitions to needs_input",
    async () => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-notify-${port}`;
      activeContexts.push({ context, sessionPrefix });
      const logPath = await installFakeDesktopNotifier(context);
      await syncTmuxEnvironment({
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig(
        "desktop-notify.yaml",
        baseConfig(context, sessionPrefix),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (await context.execCli(["--config", configPath, "spawn", "api", "notify me", "--json"]))
          .stdout,
      ) as SessionView;

      // The fixture's read loop drains a multi-line paste for up to 500ms of
      // silence (see helpers/runtime.ts's read loop comment) before treating
      // it as one complete message. The daemon's own submit-ack wait only
      // proves the paste was *delivered*, not that the fixture's drain
      // window has actually closed — so sending the next message too early
      // lands inside that still-open drain window and gets silently
      // concatenated onto the first message instead of starting a new one
      // (confirmed by inspecting the fixture's transcript jsonl on a failing
      // run). Wait for the fixture's own "ack: <message>" echo, which only
      // prints once its case statement actually runs on a closed message,
      // before sending the next one.
      await pollUntil(async () => captureTmuxPane(spawned.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("ack: notify me"),
      });

      await context.execCli(["--config", configPath, "send", spawned.id, "show-waiting-menu"]);

      const firstNotification = await pollUntil(
        async () => (existsSync(logPath) ? readFile(logPath, "utf8") : ""),
        {
          timeoutMs: 15_000,
          accept: (value) => value.includes(`Spur needs input [${spawned.id}]`),
        },
      );
      expect(firstNotification).toContain(`Spur needs input [${spawned.id}]`);

      await sleep(6_000);
      const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
      expect(log.match(new RegExp(`Spur needs input \\[${spawned.id}\\]`, "g"))).toHaveLength(1);
    },
  );

  it("restarts the daemon through the built CLI and keeps restart as a no-op once it is down", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-daemon-restart-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "daemon-restart.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const restarted = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "restart", "--json"])).stdout,
    ) as {
      baseUrl: string;
      previousPid?: number;
      restarted: boolean;
      runtime?: RuntimeInfo;
    };

    expect(restarted.restarted).toBe(true);
    expect(restarted.previousPid).toBe(daemon.info.pid);
    const restartedPid = restarted.runtime?.pid;
    expect(restartedPid).toBeTypeOf("number");
    if (typeof restartedPid !== "number") {
      throw new Error("Expected daemon restart to return a runtime pid");
    }
    currentActiveContext().daemonPid = restartedPid;

    const liveInfo = await context.fetchJson<RuntimeInfo>("/info");
    expect(liveInfo.pid).toBe(restartedPid);

    await context.execCli(["--config", configPath, "daemon", "stop", "--json"]);
    delete currentActiveContext().daemonPid;
    await expect(context.fetchJson("/info")).rejects.toThrow();

    const noop = JSON.parse(
      (await context.execCli(["--config", configPath, "daemon", "restart", "--json"])).stdout,
    ) as {
      baseUrl: string;
      previousPid?: number;
      restarted: boolean;
      runtime?: RuntimeInfo;
    };

    expect(noop).toEqual({
      baseUrl: `http://127.0.0.1:${port}`,
      restarted: false,
    });
    await expect(context.fetchJson("/info")).rejects.toThrow();
  });

  it("keeps a protected prod-style daemon restart from forking a rogue listener", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-daemon-restart-guard-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "daemon-restart-guard.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli(["--config", configPath, "daemon", "restart", "--json"], {
        env: { SPUR_DISABLE_AUTOSTART: "1" },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("SPUR_DISABLE_AUTOSTART=1"),
    });

    delete currentActiveContext().daemonPid;
    await expect(context.fetchJson("/info")).rejects.toThrow();
    await pollUntil(() => processExists(daemon.info.pid), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });

    const restarted = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = restarted.info.pid;
    expect(restarted.info.pid).not.toBe(daemon.info.pid);
  });

  it("reloads all registered projects after a restart from a different config path", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-registry-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const extraRepo = await createGitRepo();
    try {
      const baseConfigPath = await context.writeConfig(
        "registry-base.yaml",
        baseConfig(context, `${sessionPrefix}-api`),
      );
      const extraConfigPath = await context.writeConfig(
        "registry-extra.yaml",
        `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: codex
projects:
  web:
    path: ${extraRepo.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}-web
`,
      );

      const daemon = await context.startDaemon(baseConfigPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const extraSpawn = JSON.parse(
        (
          await context.execCli([
            "--config",
            extraConfigPath,
            "spawn",
            "web",
            "sync project",
            "--json",
          ])
        ).stdout,
      ) as SessionView;
      expect(extraSpawn.project).toBe("web");

      const restarted = JSON.parse(
        (await context.execCli(["--config", extraConfigPath, "daemon", "restart", "--json"]))
          .stdout,
      ) as {
        restarted: boolean;
        runtime?: RuntimeInfo;
      };
      expect(restarted.restarted).toBe(true);
      const restartedPid = restarted.runtime?.pid;
      expect(restartedPid).toBeTypeOf("number");
      if (typeof restartedPid === "number") {
        currentActiveContext().daemonPid = restartedPid;
      }

      const apiSpawn = await context.fetchJson<SessionView>("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "api",
          prompt: "registry survived restart",
          agent: "claude",
        }),
      });
      expect(apiSpawn.project).toBe("api");

      const listed = await context.fetchJson<SessionView[]>("/sessions");
      expect(listed.map((session) => session.project)).toEqual(
        expect.arrayContaining(["api", "web"]),
      );
    } finally {
      await rm(extraRepo.repoDir, { recursive: true, force: true });
      await rm(extraRepo.originDir, { recursive: true, force: true });
    }
  });

  it("keeps build as a no-op when /info is incompatible and does not expose a Spur runtime pid", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-build-noop-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "build-noop.yaml",
      baseConfig(context, sessionPrefix),
    );
    const repoRoot = join(import.meta.dirname, "..", "..", "..");
    const incompatibleServer = createServer((request, response) => {
      if (request.url === "/info") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ pid: 7777 }) + "\n");
        return;
      }
      response.writeHead(404);
      response.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        incompatibleServer.once("error", reject);
        incompatibleServer.listen(port, "127.0.0.1", () => {
          incompatibleServer.off("error", reject);
          resolve();
        });
      });

      await execFileAsync("pnpm", ["--dir", "v2", "build"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          SPUR_CONFIG: configPath,
        },
      });

      const response = await fetch(`http://127.0.0.1:${port}/info`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pid: 7777 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        incompatibleServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("rejects unknown options through the ls alias", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-ls-error-${port}`;
    activeContexts.push({ context, sessionPrefix });
    const configPath = await context.writeConfig(
      "ls-error.yaml",
      baseConfig(context, sessionPrefix),
    );

    await expect(context.execCli(["--config", configPath, "ls", "--bogus"])).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown option '--bogus'"),
    });
  });

  it("surfaces spawn and lifecycle command errors through the built CLI without leaving session state behind", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-errors-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("errors.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli(["--config", configPath, "spawn", "missing", "bad prompt"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown project: missing"),
    });

    await expect(
      context.execCli(["--config", configPath, "send", "api-999", "follow up"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli([
        "--config",
        configPath,
        "wake",
        "api-999",
        "--every",
        "5m",
        "--until",
        "CI is green",
        "Check CI",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "pause", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "complete", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "kill", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli(["--config", configPath, "respawn", "api-999"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed).toEqual([]);
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["daemon.started", "http.request.failed"]),
    );
  });

  it("respawns a completed session and rejects respawn for a running session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "respawn.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "respawn runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await expect(
      context.execCli(["--config", configPath, "respawn", spawned.id]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Session ${spawned.id} is not in a terminal state`),
    });

    // The complete gate is unconditional on session state: it 409s while the
    // fixture's seeded ToDo item is still open. The fixture resolves it via a
    // backgrounded add-then-complete round trip that can still be in flight
    // after the session reaches "waiting" (record_fixture_todo in
    // helpers/runtime.ts), so wait for the ledger itself to go clean before
    // completing.
    await waitForCleanTodoLedger(context, spawned.id);

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(completed.status).toBe("completed");
    expect(completed.runtimeAlive).toBe(false);
    expect(completed.workspaceExists).toBe(false);

    const respawned = JSON.parse(
      (await context.execCli(["--config", configPath, "respawn", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(respawned.status).toBe("running");
    expect(respawned.project).toBe(spawned.project);

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed.map((session) => session.id)).toContain(respawned.id);

    const killed = JSON.parse(
      (await context.execCli(["--config", configPath, "kill", respawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(killed.status).toBe("killed");
    expect(killed.runtimeAlive).toBe(false);
    expect(killed.workspaceExists).toBe(false);
  });

  it("keeps kill and complete working for existing sessions after the project id is renamed", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-project-rename-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("rename.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const completeSession = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "complete me", "--json"]))
        .stdout,
    ) as SessionView;
    const killSession = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "kill me", "--json"])).stdout,
    ) as SessionView;

    // The complete gate is unconditional on session state: it 409s while the
    // fixture's seeded ToDo item is still open. The fixture resolves it via a
    // backgrounded add-then-complete round trip that can still be in flight
    // after the session reaches "waiting" (record_fixture_todo in
    // helpers/runtime.ts), so wait for the ledger itself to go clean before
    // completing.
    await waitForCleanTodoLedger(context, completeSession.id);

    await writeFile(
      configPath,
      `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
admission:
  enabled: false
projects:
  web:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}-web
    symlinks:
      - .env
`,
      "utf8",
    );

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", completeSession.id, "--json"]))
        .stdout,
    ) as SessionView;
    const killed = JSON.parse(
      (await context.execCli(["--config", configPath, "kill", killSession.id, "--json"])).stdout,
    ) as SessionView;
    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];

    expect(completed.status).toBe("completed");
    expect(completed.workspaceExists).toBe(false);
    expect(killed.status).toBe("killed");
    expect(killed.workspaceExists).toBe(false);
    expect(listed).toEqual([]);
  });

  it("complete after a project rename still tears down sidecar tmux and processes", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-project-rename-sidecar-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = join(context.repoDir, "record-dev-sidecar.sh");
    await writeFile(
      sidecarPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" > ".sidecar-pid-\${SPUR_SESSION:?}"
trap 'exit 0' TERM INT HUP
while true; do
  sleep 1
done
`,
      "utf8",
    );
    await chmod(sidecarPath, 0o755);
    const configPath = await context.writeConfig(
      "rename-sidecar.yaml",
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
      dev:
        command: "${sidecarPath}"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "rename sidecar complete",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const devSessionName = `${spawned.id}--dev`;
    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    const sidecarPid = Number.parseInt(
      await pollUntil(
        async () =>
          readFile(join(spawned.worktreePath, `.sidecar-pid-${spawned.id}`), "utf8").catch(
            () => "",
          ),
        { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
      ),
      10,
    );
    expect(Number.isInteger(sidecarPid)).toBe(true);
    expect(await processExists(sidecarPid)).toBe(true);

    await writeFile(
      configPath,
      `server:
  host: 127.0.0.1
  port: ${context.port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  web:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}-web
    symlinks:
      - .env
`,
      "utf8",
    );

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(completed.status).toBe("completed");
    expect(completed.workspaceExists).toBe(false);

    const devSessionGone = !(await tmuxSessionExists(devSessionName));
    expect(devSessionGone).toBe(true);
    await pollUntil(() => processExists(sidecarPid), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });
  });

  it("creates a new worktree branch from a per-spawn worktree base override", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-default-branch-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    await execFileAsync("git", ["checkout", "-b", "release"], { cwd: context.repoDir });
    await writeFile(join(context.repoDir, "RELEASE.txt"), "release branch\n", "utf8");
    await execFileAsync("git", ["add", "RELEASE.txt"], { cwd: context.repoDir });
    await execFileAsync("git", ["commit", "-m", "release base"], { cwd: context.repoDir });
    await execFileAsync("git", ["checkout", "main"], { cwd: context.repoDir });
    const configPath = await context.writeConfig(
      "default-branch.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "default branch prompt",
          "--worktree",
          "release",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const { stdout } = await execFileAsync("git", ["show", "HEAD:RELEASE.txt"], {
      cwd: spawned.worktreePath,
    });

    expect(spawned.branch).toBe(spawned.id);
    expect(stdout.trim()).toBe("release branch");
  });

  it.each(["claude", "codex", "cursor"] as const)(
    "uses %s spawn preflight to derive the worktree branch through the built CLI",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-preflight-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const expectedBranch = `feature/${agent}-runtime-preflight`;
      const configPath = await context.writeConfig(
        `${agent}-preflight.yaml`,
        baseConfig(
          context,
          sessionPrefix,
          `    preflight:
      prompt: "Use branch hint: ${expectedBranch}"
`,
        ),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            `runtime preflight prompt for ${agent}`,
            "--agent",
            agent,
            "--json",
          ])
        ).stdout,
      ) as SessionView;

      const branch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: spawned.worktreePath,
      });

      expect(spawned.branch).toBe(expectedBranch);
      expect(spawned.branchSource).toBe("preflight");
      expect(branch.stdout.trim()).toBe(expectedBranch);
      if (agent === "cursor") {
        expect(spawned.agentSessionId).toBeTruthy();
        const chatId = spawned.agentSessionId as string;
        const transcript = await readFile(
          join(
            context.rootDir,
            ".cursor",
            "projects",
            toCursorProjectPath(spawned.worktreePath),
            "agent-transcripts",
            chatId,
            `${chatId}.jsonl`,
          ),
          "utf8",
        );
        const records = transcript
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                role?: string;
                message?: { content?: Array<{ type?: string; text?: string }> };
              },
          );
        const submittedText = records
          .find((record) => record.role === "user")
          ?.message?.content?.find((block) => block.type === "text")?.text;
        expect(submittedText?.split("\n\nSession metadata:\n")[0]).toBe(
          "runtime preflight prompt for cursor",
        );
      }
    },
  );

  it("retries spawn preflight when it picks a branch already used by another worktree", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-preflight-occupied-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const occupiedBranch = "feature/preflight-occupied";
    const retryBranch = "feature/preflight-retry";
    const occupiedWorktreePath = join(context.rootDir, "occupied-preflight-branch");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", occupiedBranch, occupiedWorktreePath, "main"],
      { cwd: context.repoDir },
    );

    try {
      const configPath = await context.writeConfig(
        "preflight-occupied.yaml",
        baseConfig(
          context,
          sessionPrefix,
          `    preflight:
      prompt: "retry branch hint: ${retryBranch} Use branch hint: ${occupiedBranch}"
`,
        ),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            "runtime preflight occupied prompt",
            "--json",
          ])
        ).stdout,
      ) as SessionView;

      expect(spawned.branch).toBe(retryBranch);
      expect(spawned.branchSource).toBe("preflight");

      const branch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: spawned.worktreePath,
      });
      expect(branch.stdout.trim()).toBe(retryBranch);
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", occupiedWorktreePath], {
        cwd: context.repoDir,
      });
    }
  });

  it("retries respawn preflight when it picks a branch already used by another worktree", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-occupied-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const occupiedBranch = "feature/respawn-occupied";
    const retryBranch = "feature/respawn-retry";
    const configPath = await context.writeConfig(
      "respawn-occupied.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    preflight:
      prompt: "retry branch hint: ${retryBranch} Use branch hint: ${occupiedBranch}"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "runtime respawn occupied prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    expect(spawned.branch).toBe(occupiedBranch);

    await context.execCli(["--config", configPath, "complete", spawned.id, "--json"]);

    const occupiedWorktreePath = join(context.rootDir, "occupied-respawn-branch");
    await execFileAsync("git", ["worktree", "add", occupiedWorktreePath, occupiedBranch], {
      cwd: context.repoDir,
    });

    try {
      const respawned = JSON.parse(
        (await context.execCli(["--config", configPath, "respawn", spawned.id, "--json"])).stdout,
      ) as SessionView;

      expect(respawned.status).toBe("running");
      expect(respawned.branch).toBe(retryBranch);
      expect(respawned.branchSource).toBe("preflight");

      const branch = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: respawned.worktreePath,
      });
      expect(branch.stdout.trim()).toBe(retryBranch);
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", occupiedWorktreePath], {
        cwd: context.repoDir,
      });
    }
  });

  it.each(["claude", "codex"] as const)(
    "fails spawn when %s preflight returns empty output",
    async (agent) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-preflight-empty-${agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig(
        `${agent}-preflight-empty.yaml`,
        baseConfig(
          context,
          sessionPrefix,
          `    preflight:
      prompt: "Return empty preflight output"
`,
        ),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      await expect(
        context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          `runtime empty preflight prompt for ${agent}`,
          "--agent",
          agent,
          "--json",
        ]),
      ).rejects.toThrow("Spawn preflight failed after 3 attempts");
    },
  );

  it("rejects an explicit branch when another worktree already has it checked out", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-branch-conflict-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const occupiedBranch = "feature/branch-conflict";
    const occupiedWorktreePath = join(context.rootDir, "occupied-explicit-branch");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", occupiedBranch, occupiedWorktreePath, "main"],
      { cwd: context.repoDir },
    );

    try {
      const configPath = await context.writeConfig(
        "branch-conflict.yaml",
        baseConfig(context, sessionPrefix),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      await expect(
        context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "runtime explicit branch conflict",
          "--branch",
          occupiedBranch,
          "--json",
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `branch "${occupiedBranch}" is already checked out in worktree ${occupiedWorktreePath}`,
        ),
      });
    } finally {
      await execFileAsync("git", ["worktree", "remove", "--force", occupiedWorktreePath], {
        cwd: context.repoDir,
      });
    }
  });

  it("fetches origin before spawn so the worktree and local base branch use the freshest main", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-fresh-main-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const remoteRepoDir = join(context.rootDir, "origin-main-clone");
    await execFileAsync("git", ["clone", "--quiet", context.originDir, remoteRepoDir]);
    try {
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: remoteRepoDir,
      });
      await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: remoteRepoDir });
      await writeFile(join(remoteRepoDir, "REMOTE.txt"), "fresh main\n", "utf8");
      await execFileAsync("git", ["add", "REMOTE.txt"], { cwd: remoteRepoDir });
      await execFileAsync("git", ["commit", "-m", "remote main update"], { cwd: remoteRepoDir });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: remoteRepoDir });
    } finally {
      await rm(remoteRepoDir, { recursive: true, force: true });
    }

    await expect(
      execFileAsync("git", ["show", "main:REMOTE.txt"], { cwd: context.repoDir }),
    ).rejects.toThrow();

    const configPath = await context.writeConfig(
      "fresh-main.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "fresh main prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const worktreeFile = await execFileAsync("git", ["show", "HEAD:REMOTE.txt"], {
      cwd: spawned.worktreePath,
    });
    const localMainFile = await execFileAsync("git", ["show", "main:REMOTE.txt"], {
      cwd: context.repoDir,
    });

    expect(worktreeFile.stdout.trim()).toBe("fresh main");
    expect(localMainFile.stdout.trim()).toBe("fresh main");
  });

  it("uses origin/main for spawn when checked-out main is dirty and origin/main is ahead", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-dirty-main-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });

    const remoteRepoDir = join(context.rootDir, "origin-dirty-main-clone");
    await execFileAsync("git", ["clone", "--quiet", context.originDir, remoteRepoDir]);
    try {
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: remoteRepoDir,
      });
      await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: remoteRepoDir });
      await writeFile(join(remoteRepoDir, "REMOTE_DIRTY.txt"), "fresh remote\n", "utf8");
      await execFileAsync("git", ["add", "REMOTE_DIRTY.txt"], { cwd: remoteRepoDir });
      await execFileAsync("git", ["commit", "-m", "remote main update for dirty branch"], {
        cwd: remoteRepoDir,
      });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: remoteRepoDir });
    } finally {
      await rm(remoteRepoDir, { recursive: true, force: true });
    }

    await writeFile(join(context.repoDir, "LOCAL_DIRTY.txt"), "local dirty change\n", "utf8");

    await expect(
      execFileAsync("git", ["show", "main:REMOTE_DIRTY.txt"], { cwd: context.repoDir }),
    ).rejects.toThrow();

    const configPath = await context.writeConfig(
      "dirty-main.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dirty main prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const worktreeFile = await execFileAsync("git", ["show", "HEAD:REMOTE_DIRTY.txt"], {
      cwd: spawned.worktreePath,
    });
    const localDirtyStatus = await execFileAsync(
      "git",
      ["status", "--short", "--", "LOCAL_DIRTY.txt"],
      {
        cwd: context.repoDir,
      },
    );

    await expect(
      execFileAsync("git", ["show", "main:REMOTE_DIRTY.txt"], { cwd: context.repoDir }),
    ).rejects.toThrow();
    expect(worktreeFile.stdout.trim()).toBe("fresh remote");
    expect(localDirtyStatus.stdout).toContain("LOCAL_DIRTY.txt");
  });

  it("spawns and kills a shared workspace session without removing the project path", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-shared-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "shared.yaml",
      `${baseConfig(context, sessionPrefix)}    worktree: false\n`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "shared workspace prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    expect(spawned.worktree).toBe(false);
    expect(spawned.worktreePath).toBe(context.repoDir);
    expect(spawned.branchSource).toBe("shared_workspace");

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("shared workspace prompt"),
    });

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "shared workspace follow up",
      "--json",
    ]);

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("shared workspace follow up"),
    });

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "k");

    const killed = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "killed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === true,
      },
    );

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );

    expect(listed).toEqual([]);
    expect(killed.worktree).toBe(false);
    expect(existsSync(context.repoDir)).toBe(true);
  });

  it("logs user inputs for spawn and send with runtime attachments", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-input-log-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "input-log.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = await context.fetchJson<SessionView>("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "api",
        prompt: "logged spawn prompt",
        agent: "claude",
      }),
    });

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("logged spawn prompt"),
    });

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "logged send prompt",
        queue: false,
        interrupt: true,
        attachments: [
          {
            name: "runtime-send.png",
            data: Buffer.from("send-bytes").toString("base64"),
          },
        ],
      }),
    });

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("logged send prompt"),
    });

    const records = readEventLog(context.dataDir).filter(
      (entry) => entry.sessionId === spawned.id && entry.event === "session.input.received",
    );
    expect(records).toEqual([
      expect.objectContaining({
        event: "session.input.received",
        message: "logged spawn prompt",
        details: expect.objectContaining({
          inputKind: "spawn_prompt",
          source: "spawn",
          text: "logged spawn prompt",
        }),
      }),
      expect.objectContaining({
        event: "session.input.received",
        message: "logged send prompt",
        details: expect.objectContaining({
          inputKind: "send_message",
          source: "send_direct",
          text: "logged send prompt",
          attachments: [
            { id: expect.stringContaining("runtime-send.png"), name: "runtime-send.png" },
          ],
        }),
      }),
    ]);
  });

  it("pauses, resumes, and completes a worktree session through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pause-complete-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pause-complete.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "pause and complete prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("pause and complete prompt"),
    });

    const paused = JSON.parse(
      (await context.execCli(["--config", configPath, "pause", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(paused.status).toBe("stopped");
    expect(paused.runtimeAlive).toBe(false);
    expect(paused.workspaceExists).toBe(true);
    expect(existsSync(spawned.worktreePath)).toBe(true);

    const pausedList = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 45_000,
        accept: (value) =>
          value[0]?.id === spawned.id &&
          value[0]?.status === "stopped" &&
          value[0]?.state === "stopped" &&
          value[0]?.runtimeAlive === false &&
          value[0]?.workspaceExists === true,
      },
    );
    expect(pausedList).toHaveLength(1);

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "resume after pause",
      "--json",
    ]);

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("resume after pause"),
    });
    await waitForCleanTodoLedger(context, spawned.id);

    const completed = JSON.parse(
      (await context.execCli(["--config", configPath, "complete", spawned.id, "--json"])).stdout,
    ) as SessionView;
    expect(completed.status).toBe("completed");
    expect(completed.runtimeAlive).toBe(false);
    expect(completed.workspaceExists).toBe(false);
    expect(existsSync(spawned.worktreePath)).toBe(false);

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );
    expect(listed).toEqual([]);

    const stored = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "completed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );
    expect(stored.status).toBe("completed");

    await expect(
      context.execCli(["--config", configPath, "send", spawned.id, "after complete"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Session is not running: ${spawned.id}`),
    });
  });

  it("mutates Spur ToDo through the built public CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-todo-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("todo.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;
    const humanCli = { env: { SPUR_SESSION: "" } };
    const spawned = JSON.parse(
      (
        await context.execCli(
          ["--config", configPath, "spawn", "api", "exercise native todo", "--json"],
          humanCli,
        )
      ).stdout,
    ) as SessionView;

    const initial = await pollUntil(
      async () =>
        JSON.parse(
          (
            await context.execCli(
              ["--config", configPath, "todo", "list", "--session", spawned.id, "--json"],
              humanCli,
            )
          ).stdout,
        ) as TodoProjection,
      {
        timeoutMs: 20_000,
        accept: (projection) => Boolean(projection.items[0]?.latestTransition),
        label: "fixture agent to record and resolve its first Spur ToDo item",
      },
    );
    expect(initial.items[0]?.added?.actor).toMatchObject({ kind: "agent" });
    expect(initial.items[0]?.latestTransition?.actor).toEqual({
      kind: "agent",
      agent: spawned.agent,
      sessionId: spawned.id,
    });

    const added = JSON.parse(
      (
        await context.execCli(
          [
            "--config",
            configPath,
            "todo",
            "add",
            "--session",
            spawned.id,
            "--text",
            "Verify CLI transitions",
            "--reason",
            "Runtime coverage",
            "--json",
          ],
          humanCli,
        )
      ).stdout,
    ) as TodoProjection;
    const item = added.items.find((candidate) => candidate.text === "Verify CLI transitions");
    if (!item) throw new Error("Expected CLI-added ToDo item");

    const held = JSON.parse(
      (
        await context.execCli(
          [
            "--config",
            configPath,
            "todo",
            "hold",
            item.id,
            "--session",
            spawned.id,
            "--reason",
            "Need operator",
            "--human-action",
            "Approve release",
            "--json",
          ],
          humanCli,
        )
      ).stdout,
    ) as TodoProjection;
    expect(held.items.find((candidate) => candidate.id === item.id)?.status).toBe("held");

    await context.execCli(
      ["--config", configPath, "todo", "resume", item.id, "--session", spawned.id, "--json"],
      humanCli,
    );
    const completed = JSON.parse(
      (
        await context.execCli(
          [
            "--config",
            configPath,
            "todo",
            "complete",
            item.id,
            "--session",
            spawned.id,
            "--reason",
            "Verified",
            "--json",
          ],
          humanCli,
        )
      ).stdout,
    ) as TodoProjection;
    expect(completed.items.find((candidate) => candidate.id === item.id)?.status).toBe("completed");
  });

  it("persists recurring wake state from wake through CLI, list, API, and disk", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-wake-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("wake.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "wake persistence prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const woken = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "wake",
          spawned.id,
          "--every",
          "5m",
          "--until",
          "CI is green",
          "Check CI",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    expect(woken.intervalWake).toEqual(
      expect.objectContaining({
        intervalMs: 300_000,
        message: "Check CI",
        stopCondition: "CI is green",
      }),
    );
    const intervalWake = woken.intervalWake;
    if (!intervalWake) {
      throw new Error("Expected interval wake in CLI response");
    }

    const rawSession = JSON.parse(
      await readFile(join(context.dataDir, "sessions", "api", `${spawned.id}.json`), "utf8"),
    ) as SessionRecord;
    expect(rawSession.intervalWake).toEqual(intervalWake);

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed.find((session) => session.id === spawned.id)?.intervalWake).toEqual(intervalWake);

    const apiSession = await context.fetchJson<SessionView>(`/sessions/${spawned.id}`);
    expect(apiSession.intervalWake).toEqual(intervalWake);

    const dailyOutput = (
      await context.execCli([
        "--config",
        configPath,
        "wake",
        spawned.id,
        "--daily-at",
        "09:00,17:00",
        "--until",
        "Daily checks done",
        "Check daily state",
        "--json",
      ])
    ).stdout;
    let dailyWoken: SessionView;
    try {
      dailyWoken = JSON.parse(dailyOutput) as SessionView;
    } catch {
      throw new Error(`Expected daily wake JSON response: ${dailyOutput}`);
    }
    expect(dailyWoken.dailyWake).toEqual(
      expect.objectContaining({
        dailyAt: ["09:00", "17:00"],
        message: "Check daily state",
        stopCondition: "Daily checks done",
      }),
    );
    const dailyWake = dailyWoken.dailyWake;
    if (!dailyWake) {
      throw new Error("Expected daily wake in CLI response");
    }

    const dailyRawSessionText = await readFile(
      join(context.dataDir, "sessions", "api", `${spawned.id}.json`),
      "utf8",
    );
    let dailyRawSession: SessionRecord;
    try {
      dailyRawSession = JSON.parse(dailyRawSessionText) as SessionRecord;
    } catch {
      throw new Error(`Expected daily wake session JSON on disk: ${dailyRawSessionText}`);
    }
    expect(dailyRawSession.dailyWake).toEqual(dailyWake);

    const dailyListedOutput = (await context.execCli(["--config", configPath, "list", "--json"]))
      .stdout;
    let dailyListed: SessionView[];
    try {
      dailyListed = JSON.parse(dailyListedOutput) as SessionView[];
    } catch {
      throw new Error(`Expected daily wake list JSON: ${dailyListedOutput}`);
    }
    expect(dailyListed.find((session) => session.id === spawned.id)?.dailyWake).toEqual(dailyWake);

    const dailyApiSession = await context.fetchJson<SessionView>(`/sessions/${spawned.id}`);
    expect(dailyApiSession.dailyWake).toEqual(dailyWake);

    await expect(
      context.execCli(["--config", configPath, "wake", spawned.id, "--daily-at", "09:00"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--daily-at requires --until"),
    });
  });

  it("pauses and completes a session through the interactive list", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-list-pause-complete-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "list-pause-complete.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "interactive pause and complete",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    // The fixture agent records and resolves its first Spur ToDo item during
    // startup, before it signals waiting. Wait for that here so the later
    // interactive complete ('c') does not race a pane pause into an empty
    // ledger, which the daemon now refuses.
    await pollUntil(
      async () =>
        JSON.parse(
          (
            await context.execCli([
              "--config",
              configPath,
              "todo",
              "list",
              "--session",
              spawned.id,
              "--json",
            ])
          ).stdout,
        ) as TodoProjection,
      {
        timeoutMs: 20_000,
        accept: (projection) => Boolean(projection.items[0]?.latestTransition),
        label: "fixture agent to record and resolve its first Spur ToDo item",
      },
    );

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "p");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`Stopped ${spawned.id}.`),
    });

    const pausedList = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 45_000,
        accept: (value) =>
          value[0]?.id === spawned.id &&
          value[0]?.status === "stopped" &&
          value[0]?.state === "stopped" &&
          value[0]?.runtimeAlive === false &&
          value[0]?.workspaceExists === true,
      },
    );
    expect(pausedList).toHaveLength(1);

    await sendKeysToTmux(controllerSessionName, "c");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes(`Completed ${spawned.id}.`) && value.includes("No sessions."),
    });

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );
    expect(listed).toEqual([]);

    const stored = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "completed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );
    expect(stored.status).toBe("completed");

    await sendKeysToTmux(controllerSessionName, "q");
  });

  it("rejects a shared-workspace branch override through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-shared-branch-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "shared-branch.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli([
        "--config",
        configPath,
        "spawn",
        "api",
        "bad branch override",
        "--shared",
        "--branch",
        "feature/shared",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "branch override requires worktree=true; shared workspace is on branch main",
      ),
    });

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed).toEqual([]);
  });

  it("updates live session slots through the helper command and only shows tmux status for titled sessions", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-slots-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("slots.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "slot runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur-slots");
    expect(existsSync(helperPath)).toBe(true);
    const initialStatus = await readTmuxStatus(spawned.id);
    expect(initialStatus).toBe("off");

    await execFileAsync(helperPath, [
      "--title",
      "Investigate status bar links",
      "--link",
      "tracker=https://tracker.example.com/TASK-9",
      "--link",
      "github-pr=https://github.com/org/repo/pull/9",
    ]);

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value[0]?.slots?.title === "Investigate status bar links" &&
          value[0]?.slots?.links?.length === 2,
      },
    );

    const status = await readTmuxStatus(spawned.id);

    expect(listed[0]?.slots).toEqual({
      title: "Investigate status bar links",
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-9" },
        { label: "pr", url: "https://github.com/org/repo/pull/9" },
      ],
    });
    expect(status).toBe("off");
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toContain(
      "session.slots.updated",
    );
  });

  it("unlinks a generic pr slot before clearing the native GitHub PR binding in runtime flows", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pr-unlink-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pr-unlink.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "mixed pr unlink runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur-slots");
    expect(existsSync(helperPath)).toBe(true);

    const githubPrUrl = "https://github.com/org/repo/pull/9";
    const gitlabPrUrl = "https://gitlab.com/org/repo/-/merge_requests/7";
    writeSession(context.dataDir, {
      ...requireSessionRecord(context.dataDir, spawned.id),
      pr: {
        number: 9,
        repo: "org/repo",
        url: githubPrUrl,
      },
      slots: {
        title: "Investigate mixed pr bindings",
        links: [
          { label: "tracker", url: "https://tracker.example.com/TASK-9" },
          { label: "pr", url: gitlabPrUrl },
        ],
      },
    });

    const mixedResult = JSON.parse(
      (await execFileAsync(helperPath, ["--json", "--unlink", "pr"])).stdout,
    ) as SessionView;
    const afterFirstUnlink = requireSessionRecord(context.dataDir, spawned.id);
    const statusAfterFirstUnlink = await readTmuxStatus(spawned.id);

    expect(mixedResult.pr).toEqual({
      number: 9,
      repo: "org/repo",
      url: githubPrUrl,
    });
    expect(mixedResult.slots).toEqual({
      title: "Investigate mixed pr bindings",
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-9" },
        { label: "pr", url: githubPrUrl },
      ],
    });
    expect(afterFirstUnlink.pr).toEqual({
      number: 9,
      repo: "org/repo",
      url: githubPrUrl,
    });
    expect(afterFirstUnlink.slots).toEqual({
      title: "Investigate mixed pr bindings",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
    expect(statusAfterFirstUnlink).toBe("off");

    const nativeOnlyResult = JSON.parse(
      (await execFileAsync(helperPath, ["--json", "--unlink", "pr"])).stdout,
    ) as SessionView;
    const afterSecondUnlink = requireSessionRecord(context.dataDir, spawned.id);
    const statusAfterSecondUnlink = await readTmuxStatus(spawned.id);

    expect(nativeOnlyResult.pr).toBeUndefined();
    expect(nativeOnlyResult.slots).toEqual({
      title: "Investigate mixed pr bindings",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
    expect(afterSecondUnlink.pr).toBeUndefined();
    expect(afterSecondUnlink.slots).toEqual({
      title: "Investigate mixed pr bindings",
      links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
    });
    expect(statusAfterSecondUnlink).toBe("off");
  });

  it("surfaces session artifacts from daemon-owned storage and removes them on complete", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-artifacts-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "artifacts.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "artifact runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const artifactDir = join(context.dataDir, "session-artifacts", spawned.id);
    const artifactPath = join(artifactDir, "capture.png");
    await writeFile(artifactPath, "artifact-bytes", "utf8");

    const sessionWithArtifact = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) => value.artifacts?.[0]?.id === "capture.png",
      },
    );
    expect(sessionWithArtifact.artifacts?.[0]).toMatchObject({
      id: "capture.png",
      kind: "image",
    });

    const response = await fetch(
      `http://127.0.0.1:${daemon.info.port}/sessions/${spawned.id}/artifacts/capture.png`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    await expect(response.text()).resolves.toBe("artifact-bytes");

    await context.execCli(["--config", configPath, "complete", spawned.id, "--json"]);
    expect(existsSync(artifactDir)).toBe(false);

    const missing = await fetch(
      `http://127.0.0.1:${daemon.info.port}/sessions/${spawned.id}/artifacts/capture.png`,
    );
    expect(missing.status).toBe(404);
  });

  it("serves artifact files whose names require URL encoding", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-artifacts-encoded-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "artifacts-encoded.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "artifact encoded runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const artifactDir = join(context.dataDir, "session-artifacts", spawned.id);
    await writeFile(join(artifactDir, "my screenshot.png"), "artifact-bytes", "utf8");

    const sessionWithArtifact = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) => value.artifacts?.some((artifact) => artifact.id === "my screenshot.png"),
      },
    );
    expect(
      sessionWithArtifact.artifacts?.some((artifact) => artifact.id === "my screenshot.png"),
    ).toBe(true);

    const response = await fetch(
      `http://127.0.0.1:${daemon.info.port}/sessions/${spawned.id}/artifacts/my%20screenshot.png`,
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("artifact-bytes");
  });

  it("runs a session-bound service and opens the live session log view from the TTY list", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "service.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    sources:
      web-watch:
        type: service
        service: web
        intervalMs: 500
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers: {}
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "service runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur");

    const runResult = JSON.parse(
      (
        await execFileAsync(
          helperPath,
          [
            "service",
            "run",
            "web",
            "--port",
            "3000",
            "--json",
            "--",
            "sh",
            "-lc",
            `'printf "SERVICE_BOOT\\n"; sleep 30'`,
          ],
          {
            cwd: spawned.worktreePath,
            env: {
              ...context.env,
              SPUR_SESSION: spawned.id,
            },
          },
        )
      ).stdout,
    ) as ServiceInstanceView;

    expect(runResult.serviceId).toBe("web");
    expect(runResult.port).toBe(3000);

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (
            await context.execCli([
              "--config",
              configPath,
              "service",
              "status",
              spawned.id,
              "--json",
            ])
          ).stdout,
        ) as ServiceInstanceView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value[0]?.serviceId === "web" && value[0]?.runtimeAlive === true,
      },
    );
    expect(listed).toHaveLength(1);

    const detail = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "service",
          "status",
          spawned.id,
          "web",
          "--json",
        ])
      ).stdout,
    ) as ServiceInstanceView;
    expect(detail.tmuxSession).toBe(`${spawned.id}--svc--web`);
    expect(detail.port).toBe(3000);
    expect(detail.state).toBe("running");

    const helperLogs = JSON.parse(
      (
        await execFileAsync(helperPath, ["service", "logs", "--json"], {
          cwd: spawned.worktreePath,
          env: {
            ...context.env,
            SPUR_SESSION: spawned.id,
          },
        })
      ).stdout,
    ) as SpurLogEntry[];
    expect(helperLogs).toEqual([]);

    const controllerSessionName = `${sessionPrefix}-service-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("l logs") && value.includes("service web:3000:running"),
    });

    await sendKeysToTmux(controllerSessionName, "l");

    const logPane = await pollUntil(async () => captureTmuxPane(controllerSessionName, 1000), {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes(`Logs ${spawned.id}`) &&
        value.includes("session.spawn.completed") &&
        value.includes("service.run.completed") &&
        value.includes("(runtime log capture unavailable)"),
    });
    expect(logPane).toContain("service.run.completed");
    expect(logPane).toContain("Agent Output");
    expect(logPane).toContain("(runtime log capture unavailable)");
    expect(logPane).not.toContain("SERVICE_BOOT");

    await sendKeysToTmux(controllerSessionName, "C-g");

    const detachedPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("l logs"),
    });
    expect(detachedPane).toContain("l logs");
  });

  it("returns an empty sidecar log result when runtime log capture is disabled", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-logs-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = join(context.repoDir, "record-browser-sidecar.sh");
    await writeFile(
      sidecarPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'BROWSER_READY\n'
sleep 30
`,
      "utf8",
    );
    await chmod(sidecarPath, 0o755);
    const configPath = await context.writeConfig(
      "sidecar-logs.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      browser:
        command: "./record-browser-sidecar.sh"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "browser logs", "--json"]))
        .stdout,
    ) as SessionView;

    const sidecarLogs = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "service",
          "logs",
          spawned.id,
          "browser",
          "--sidecar",
          "--json",
        ])
      ).stdout,
    ) as SpurLogEntry[];
    expect(sidecarLogs).toEqual([]);
  });

  it("surfaces service command errors through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-errors-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "service-errors.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    sources:
      web-watch:
        type: service
        service: web
        intervalMs: 500
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers: {}
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "service error prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", spawned.id, "spur");

    await expect(
      context.execCli(
        ["--config", configPath, "service", "run", "web", "--json", "--", "echo", "hi"],
        { env: { SPUR_SESSION: "" } },
      ),
    ).rejects.toThrow("service run requires a live Spur session");

    await expect(
      context.execCli(["--config", configPath, "service", "status", "api-999", "--json"]),
    ).rejects.toThrow("Session not found: api-999");

    await execFileAsync(
      helperPath,
      ["service", "run", "web", "--json", "--", "sh", "-lc", `'printf "SERVICE_DONE\\n"; sleep 1'`],
      {
        cwd: spawned.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: spawned.id,
        },
      },
    );

    const stopped = await pollUntil(
      async () =>
        JSON.parse(
          (
            await context.execCli([
              "--config",
              configPath,
              "service",
              "status",
              spawned.id,
              "web",
              "--json",
            ])
          ).stdout,
        ) as ServiceInstanceView,
      {
        timeoutMs: 20_000,
        // `remain-on-exit` now keeps the tmux session alive with a dead pane
        // after the command finishes, so `runtimeAlive` (tmux session exists)
        // stays true by design — poll on the pane-aware `state` field instead.
        accept: (value) => value.state === "stopped" || value.state === "error",
      },
    );
    expect(["stopped", "error"]).toContain(stopped.state);
  });

  it("rejects service logs without a session id outside a Spur session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-service-logs-errors-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "service-logs-errors.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli(["--config", configPath, "service", "logs", "--json"], {
        env: { SPUR_SESSION: "" },
      }),
    ).rejects.toThrow("service logs requires a session id or SPUR_SESSION");
  });

  it("rejects invalid or missing slot targets through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-slots-error-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "slots-error.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await expect(
      context.execCli([
        "--config",
        configPath,
        "slots",
        "--session",
        "api-999",
        "--title",
        "missing session",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found: api-999"),
    });

    await expect(
      context.execCli([
        "--config",
        configPath,
        "slots",
        "--session",
        "api-999",
        "--link",
        "broken",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--link must use label=url"),
    });
  });

  it("spawns, sends, and kills a session through the interactive list", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cli-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("cli.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "initial runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("initial runtime prompt"),
    });

    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "follow up runtime prompt",
      "--json",
    ]);

    const paneAfterSend = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("follow up runtime prompt"),
    });
    expect(paneAfterSend).toContain("initial runtime prompt");

    const listed = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.runtimeAlive).toBe(true);
    expect(listed[0]?.workspaceExists).toBe(true);

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "k");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes(`Killed ${spawned.id}.`),
    });

    const killed = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "killed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );

    const listedAfterKill = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );

    expect(listedAfterKill).toEqual([]);
    expect(killed.status).toBe("killed");
    const events = readEventLog(context.dataDir).map((entry) => entry.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "daemon.started",
        "session.spawn.completed",
        "session.input.received",
        "session.kill.completed",
      ]),
    );
    expect(
      events.some(
        (event) => event === "session.message.sent" || event === "session.message.queued",
      ),
    ).toBe(true);

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("No sessions."),
    });

    await sendKeysToTmux(controllerSessionName, "q");
  });

  it("keeps manual spawn as one task prompt through the built CLI", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pipeline-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pipeline.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "ship the task", "--json"]))
        .stdout,
    ) as SessionView;

    const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });
    const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });

    expect(pane).toContain("ship the task");
    expect(log).toContain("ship the task");
  });

  it("spawns a session through the built CLI without sending an initial prompt", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-empty-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "empty-prompt.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - research
        - test
    preflight:
      prompt: Suggest a branch name from the task context.
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "--json"])).stdout,
    ) as SessionView;

    expect(spawned.prompt).toBe("");
    expect(spawned.pipeline).toBeUndefined();

    const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Claude Code") && value.includes("❯"),
    });
    const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("startup:launch::"),
    });
    const listed = await context.fetchJson<SessionListItemView[]>("/sessions");
    const listedDetail = await context.fetchJson<SessionView>(`/sessions/${spawned.id}`);

    expect(log).toContain("startup:launch::");
    expect(log).not.toContain("research");
    expect(log).not.toContain("[Spur step");
    expect(pane).not.toContain("[Spur step");
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]).not.toHaveProperty("prompt");
    expect(listed[0]?.pipeline).toBeUndefined();
    expect(listedDetail.prompt).toBe("");
  });

  it.each([
    { agent: "claude", expectPlanFlag: true },
    { agent: "codex", expectPlanFlag: false },
    { agent: "cursor", expectPlanFlag: true },
  ] as const)(
    "accepts --plan for $agent and applies startup behavior only where supported",
    async (row) => {
      const port = await findFreePort();
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-plan-${row.agent}-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await context.writeConfig(
        "plan-flag.yaml",
        baseConfig(context, sessionPrefix),
      );
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;

      const spawned = JSON.parse(
        (
          await context.execCli([
            "--config",
            configPath,
            "spawn",
            "api",
            "plan mode check",
            "--agent",
            row.agent,
            "--plan",
            "--json",
          ])
        ).stdout,
      ) as SessionView;

      expect(spawned.planMode).toBe(true);
      const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
        timeoutMs: 15_000,
        accept: (value) => value.includes("startup:launch::"),
      });
      if (row.expectPlanFlag) {
        expect(log).toContain("plan");
        if (row.agent === "claude") {
          expect(log).toContain("--permission-mode");
        } else {
          expect(log).toContain("--plan");
        }
      } else {
        expect(log).not.toContain("--permission-mode");
      }
    },
  );

  it("uses project default spawn steps, paces later steps, and lets CLI steps override them", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-pipeline-defaults-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "pipeline-defaults.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - "research"
        - "test"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const defaultSpawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "ship the task", "--json"]))
        .stdout,
    ) as SessionView;

    const defaultPane = await pollUntil(async () => captureTmuxPane(defaultSpawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/2: research]"),
    });
    expect(defaultPane).toContain("ship the task");
    expect(defaultPane).toContain("[Spur step 1/2: research]");

    await sleep(5_000);
    const earlyDefaultLog = await context.readAgentLog(defaultSpawned.id);
    expect(earlyDefaultLog).not.toContain("[Spur step 2/2: test]");

    const defaultLog = await pollUntil(async () => context.readAgentLog(defaultSpawned.id), {
      timeoutMs: 45_000,
      accept: (value) => value.includes("[Spur step 2/2: test]"),
    });
    expect(defaultLog).toContain("[Spur step 2/2: test]");

    const overridden = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "ship the task",
          "--step",
          "review",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const overridePane = await pollUntil(async () => captureTmuxPane(overridden.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/1: review]"),
    });
    expect(overridePane).toContain("ship the task");
    expect(overridePane).toContain("[Spur step 1/1: review]");
    expect(overridePane).not.toContain("[Spur step 1/2: research]");
  });

  it("disables spawn steps in plan mode and sends the planning prompt", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-plan-no-steps-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "plan-no-steps.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - "research"
        - "test"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "ship the task",
          "--plan",
          "--step",
          "review",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    expect(spawned.planMode).toBe(true);
    expect(spawned.pipeline).toBeUndefined();
    const pane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ship the task"),
    });
    expect(pane).toContain("ship the task");
    expect(pane).toContain("Plan mode: do not write or modify code.");
    expect(pane).not.toContain("[Spur step");
  });

  it("queues a busy manual send and delivers it before the next pipeline step", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-send-queue-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "send-queue.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    spawn:
      steps:
        - "research"
        - "test"
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "ship the task", "--json"]))
        .stdout,
    ) as SessionView;

    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("[Spur step 1/2: research]"),
    });

    await context.execCli(["--config", configPath, "send", spawned.id, "simulate-work", "--json"]);
    await context.execCli([
      "--config",
      configPath,
      "send",
      spawned.id,
      "queued follow up",
      "--json",
    ]);

    await sleep(10_000);
    const earlyQueuedLog = await context.readAgentLog(spawned.id);
    expect(earlyQueuedLog).toContain("simulate-work");
    expect(earlyQueuedLog).not.toContain("queued follow up");

    const queuedLog = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 30_000,
      accept: (value) => value.includes("queued follow up"),
    });
    expect(queuedLog).toContain("simulate-work");
    expect(queuedLog).toContain("queued follow up");
    expect(queuedLog).not.toContain("[Spur step 2/2: test]");

    const finalLog = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 45_000,
      accept: (value) => value.includes("[Spur step 2/2: test]"),
    });
    expect(finalLog.indexOf("queued follow up")).toBeGreaterThan(-1);
    expect(finalLog.indexOf("[Spur step 2/2: test]")).toBeGreaterThan(
      finalLog.indexOf("queued follow up"),
    );
  });

  it("claude submit-ack survives a pane left in tmux copy-mode", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-copy-mode-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "copy-mode.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "copy-mode initial prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await pollUntil(async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`), {
      timeoutMs: 45_000,
      accept: (value) => value.state === "waiting",
    });

    await execTmux(["copy-mode", "-t", spawned.tmuxSession]);

    const startedAt = Date.now();
    await context.execCli(
      ["--config", configPath, "send", spawned.id, "copy-mode survival", "--json"],
      { timeoutMs: 10_000 },
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(10_000);

    const log = await pollUntil(async () => context.readAgentLog(spawned.id), {
      timeoutMs: 10_000,
      accept: (value) => value.includes("copy-mode survival"),
    });
    expect(log).toContain("copy-mode survival");
  });

  it("blocks kill from the interactive list when the worktree is dirty", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cli-dirty-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "cli-dirty.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dirty runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await writeFile(join(spawned.worktreePath, "DIRTY.txt"), "dirty change\n", "utf8");

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "k");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) =>
        value.includes(
          `Kill confirmation required for ${spawned.id}: uncommitted changes in its worktree. Press k again to kill anyway.`,
        ),
    });

    const sessionsAfterBlock = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    expect(sessionsAfterBlock[0]?.status).toBe("running");
    expect(sessionsAfterBlock[0]?.runtimeAlive).toBe(true);
    expect(sessionsAfterBlock[0]?.workspaceExists).toBe(true);

    await expect(
      context.fetchJson(`/sessions/${spawned.id}/kill`, {
        method: "POST",
      }),
    ).rejects.toThrow(
      `Kill confirmation required for ${spawned.id}: uncommitted changes in its worktree`,
    );

    await sendKeysToTmux(controllerSessionName, "k");

    const killed = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
      {
        timeoutMs: 15_000,
        accept: (value) =>
          value.status === "killed" &&
          value.runtimeAlive === false &&
          value.workspaceExists === false,
      },
    );

    const listedAfterKill = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 15_000,
        accept: (value) => value.length === 0,
      },
    );
    expect(listedAfterKill).toEqual([]);
    expect(killed.status).toBe("killed");

    await sendKeysToTmux(controllerSessionName, "q");
  });

  it("requires confirmation before killing a session with unpushed commits", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-cli-unpushed-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "cli-unpushed.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "unpushed runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await writeFile(join(spawned.worktreePath, "UNPUSHED.txt"), "unpushed change\n", "utf8");
    await execFileAsync("git", ["add", "UNPUSHED.txt"], { cwd: spawned.worktreePath });
    await execFileAsync("git", ["commit", "-m", "unpushed change"], { cwd: spawned.worktreePath });

    await expect(
      context.fetchJson(`/sessions/${spawned.id}/kill`, {
        method: "POST",
      }),
    ).rejects.toThrow(`Kill confirmation required for ${spawned.id}: unpushed commits`);

    const forced = await context.fetchJson<SessionView>(`/sessions/${spawned.id}/kill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe("killed");
    expect(forced.workspaceExists).toBe(false);
    expect(forced.runtimeAlive).toBe(false);
  });

  it("attaches in place from the TTY list and returns after detach", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-attach-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig("attach.yaml", baseConfig(context, sessionPrefix));
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    await context.execCli([
      "--config",
      configPath,
      "spawn",
      "api",
      "attach runtime prompt",
      "--json",
    ]);

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "Enter");

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Ctrl+G back"),
    });

    await sendKeysToTmux(controllerSessionName, "C-g");

    const detachedPane = await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Enter attach"),
    });

    expect(detachedPane).toContain(
      "Enter attach  l logs  p pause  c complete  r restore  k kill  Ctrl+G detach  Esc quit",
    );
  });

  it("restores an exited session in place from the TTY list", async () => {
    const result = await runRestoreScenario({ configName: "restore.yaml" });
    expect(result.spawned.agent).toBe("claude");
  });

  it("restores a manually stopped session in place without sending a restore prompt", async () => {
    const result = await runRestoreScenario({
      configName: "restore-paused.yaml",
      stopMode: "pause",
      expectRestorePrompt: false,
    });
    expect(result.spawned.agent).toBe("claude");
    expect(result.pane).not.toContain("This session was restored after the agent exited.");
  });

  it("restores a codex session through the native resume command", async () => {
    const result = await runRestoreScenario({ agent: "codex", configName: "restore-codex.yaml" });
    expect(result.spawned.agent).toBe("codex");
  });

  it("restores a cursor session through the native resume command", async () => {
    const result = await runRestoreScenario({
      agent: "cursor",
      configName: "restore-cursor.yaml",
    });
    expect(result.spawned.agent).toBe("cursor");
  });

  it("restores a rebooted session and its autoStart sidecar when restoreAfterReboot is on", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-reboot-on-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = await writeLongLivedSidecar(context);
    const configPath = await context.writeConfig(
      "reboot-restore-on.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    restoreAfterReboot: true
    sidecars:
      dev:
        command: "${sidecarPath}"
        autoStart: true
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "reboot prompt", "--json"]))
        .stdout,
    ) as SessionView;
    const devSessionName = `${spawned.id}--dev`;
    await pollUntil(() => tmuxSessionExists(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });

    await stopDaemonByPid(daemon.info.pid);
    delete currentActiveContext().daemonPid;
    await pollUntil(() => processExists(daemon.info.pid), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });
    await execTmux(["kill-server"]);
    await pollUntil(() => tmuxSessionExists(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });

    const restarted = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = restarted.info.pid;

    const restored = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 20_000,
        accept: (value) => value[0]?.status === "running" && value[0]?.runtimeAlive === true,
      },
    );
    expect(restored[0]?.id).toBe(spawned.id);
    await pollUntil(() => tmuxSessionExists(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
  });

  it("leaves a rebooted session stopped when restoreAfterReboot is off", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-reboot-off-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = await writeLongLivedSidecar(context);
    const configPath = await context.writeConfig(
      "reboot-restore-off.yaml",
      baseConfig(
        context,
        sessionPrefix,
        `    sidecars:
      dev:
        command: "${sidecarPath}"
        autoStart: true
`,
      ),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "reboot prompt", "--json"]))
        .stdout,
    ) as SessionView;
    await pollUntil(() => tmuxSessionExists(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });

    await stopDaemonByPid(daemon.info.pid);
    delete currentActiveContext().daemonPid;
    await pollUntil(() => processExists(daemon.info.pid), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });
    await execTmux(["kill-server"]);
    await pollUntil(() => tmuxSessionExists(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value === false,
    });

    const restarted = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = restarted.info.pid;

    const listed = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 20_000,
        accept: (value) => value[0]?.status === "stopped",
      },
    );
    expect(listed[0]?.id).toBe(spawned.id);
    expect(listed[0]?.runtimeAlive).toBe(false);
    expect(await tmuxSessionExists(spawned.id)).toBe(false);
  });

  it("completes the calling live session after a session-bound respawn succeeds", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-parent-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "respawn-parent.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const caller = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "caller runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const target = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "respawn target prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    await context.execCli(["--config", configPath, "complete", target.id, "--json"]);

    const helperPath = join(context.dataDir, "session-tools", caller.id, "spur");
    const respawned = JSON.parse(
      (
        await execFileAsync(helperPath, ["respawn", target.id, "--json"], {
          cwd: caller.worktreePath,
          env: {
            ...context.env,
            SPUR_SESSION: caller.id,
            SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", caller.id),
          },
        })
      ).stdout,
    ) as SessionView;

    expect(respawned.id).not.toBe(target.id);
    expect(respawned.status).toBe("running");

    const completedCaller = await pollUntil(
      async () => context.fetchJson<SessionView>(`/sessions/${encodeURIComponent(caller.id)}`),
      {
        timeoutMs: 15_000,
        accept: (session) =>
          session.status === "completed" &&
          session.runtimeAlive === false &&
          session.workspaceExists === false,
      },
    );
    expect(completedCaller.status).toBe("completed");
    expect(completedCaller.runtimeAlive).toBe(false);
    expect(completedCaller.workspaceExists).toBe(false);
  });

  it("keeps the calling live session running when a session-bound respawn fails", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-respawn-parent-fail-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "respawn-parent-fail.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const caller = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "caller runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;
    const helperPath = join(context.dataDir, "session-tools", caller.id, "spur");

    await expect(
      execFileAsync(helperPath, ["respawn", "api-999", "--json"], {
        cwd: caller.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: caller.id,
          SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", caller.id),
        },
      }),
    ).rejects.toThrow("Session not found: api-999");

    const sessions = JSON.parse(
      (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
    ) as SessionView[];
    const liveCaller = sessions.find((session) => session.id === caller.id);
    expect(liveCaller?.status).toBe("running");
    expect(liveCaller?.runtimeAlive).toBe(true);
    expect(liveCaller?.workspaceExists).toBe(true);
  });

  it("falls back to a fresh launch in the TTY list when native resume state is missing", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-restore-missing-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "restore-missing.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "restore runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    // The fixture's read loop drains a multi-line paste for up to 500ms of
    // silence before treating it as one complete message. The daemon's
    // submit-ack wait only proves the initial prompt was *delivered*, not
    // that the fixture's drain window has closed — sending "exit-now" too
    // early lands inside that still-open window and gets silently
    // concatenated onto the initial prompt instead of matching the
    // `exit-now` case arm, so the fixture never exits and the state poll
    // below times out waiting for an "error" state that can never arrive.
    // Wait for the fixture's own "ack: <prompt>" echo, which only prints
    // once its case statement runs on the closed initial message.
    await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("ack: restore runtime prompt"),
    });
    await context.execCli(["--config", configPath, "send", spawned.id, "exit-now", "--json"]);

    // The agent process exits on its own, leaving the tmux pane/session alive
    // with no matching process — reconcileUnexpectedStop treats that as an
    // unexpected crash (status "errored"), not a clean stop. See
    // "fix(session): preserve agent exit errors".
    await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 45_000,
        accept: (value) => value[0]?.state === "error" && value[0]?.runtimeAlive === true,
      },
    );

    await rm(join(context.rootDir, ".claude"), { recursive: true, force: true });

    const controllerSessionName = `${sessionPrefix}-ui`;
    currentActiveContext().controllerSessionName = controllerSessionName;
    await createTmuxSession({
      sessionName: controllerSessionName,
      cwd: context.rootDir,
      command: `${process.execPath} ${CLI_PATH} --config ${configPath} list`,
      env: {
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      },
    });

    await pollUntil(async () => captureTmuxPane(controllerSessionName), {
      timeoutMs: 15_000,
      accept: (value) => value.includes("Sessions"),
    });

    await sendKeysToTmux(controllerSessionName, "r");
    const restored = await pollUntil(
      async () =>
        JSON.parse(
          (await context.execCli(["--config", configPath, "list", "--json"])).stdout,
        ) as SessionView[],
      {
        timeoutMs: 30_000,
        accept: (value) => value[0]?.state !== "error" && value[0]?.runtimeAlive === true,
      },
    );
    const restoredPane = await pollUntil(async () => captureTmuxPane(spawned.id), {
      timeoutMs: 30_000,
      accept: (value) => value.includes("This session was restored after the agent exited."),
    });

    await sendKeysToTmux(controllerSessionName, "q");

    expect(restored[0]?.id).toBe(spawned.id);
    expect(restored[0]?.runtimeAlive).toBe(true);
    expect(existsSync(restored[0]?.worktreePath ?? "")).toBe(true);
    expect(restoredPane).toContain("Original task:");
    const pinnedSessionId = spawned.agentSessionId;
    expect(pinnedSessionId).toBeTruthy();
    const agentLog = await context.readAgentLog(spawned.id);
    const startupLines = agentLog.split("\n").filter((line) => line.includes("startup:"));
    const lastStartupLine = startupLines[startupLines.length - 1] ?? "";
    expect(lastStartupLine).toContain("startup:launch:");
    expect(lastStartupLine).toContain(`--session-id ${pinnedSessionId}`);
  });

  it("POST /sessions/:id/sidecars/:name/start creates the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-start-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-start.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server start test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/dev/start`, {
      method: "POST",
    });

    const devSessionName = `${spawned.id}--dev`;
    const devSessionAlive = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 10_000,
      accept: (v) => v === true,
    });
    expect(devSessionAlive).toBe(true);
  });

  it("manual sidecar start and stop toggles the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-cli-stop-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-cli-stop.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
    devServer:
      command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server cli stop test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${spawned.id}--dev`;
    await context.execCli([
      "--config",
      configPath,
      "sidecar",
      "start",
      "--session",
      spawned.id,
      "--name",
      "dev",
      "--json",
    ]);
    const devSessionAlive = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 10_000,
      accept: (v) => v === true,
    });
    expect(devSessionAlive).toBe(true);

    await context.execCli([
      "--config",
      configPath,
      "sidecar",
      "stop",
      "--session",
      spawned.id,
      "--name",
      "dev",
      "--json",
    ]);
    const devSessionStopped = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 10_000,
      accept: (v) => v === false,
    });
    expect(devSessionStopped).toBe(false);

    const sidecarEvents = readEventLog(context.dataDir)
      .map((e) => e.event)
      .filter((ev) => typeof ev === "string" && ev.startsWith("session.sidecar"));
    expect(sidecarEvents).toContain("session.sidecar.started");
    expect(sidecarEvents).toContain("session.sidecar.stopped");
  });

  it("hidden sidecar start command creates the configured sidecar tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-cli-start-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "sidecar-cli-start.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "sidecar cli start test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.execCli([
      "--config",
      configPath,
      "sidecar",
      "start",
      "--session",
      spawned.id,
      "--name",
      "dev",
      "--json",
    ]);

    const devSessionAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--dev`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(devSessionAlive).toBe(true);
  });

  it("spur-sidecar helper lets a first-level sidecar manually start one nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-helper-nested-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = await writeSidecarDepthRecorder(context, "record-nested-sidecar.sh");
    const configPath = await context.writeConfig(
      "sidecar-helper-nested.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
        autoStart: true
      preview:
        command: "${recorderPath}"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar helper test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--dev`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(devAlive).toBe(true);

    const helperPath = sessionSidecarHelperPath(context, spawned.id);
    await execFileAsync(helperPath, ["--name", "preview", "--json"], {
      cwd: spawned.worktreePath,
      env: {
        ...context.env,
        SPUR_SESSION: spawned.id,
        SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", spawned.id),
        SPUR_SIDECAR_DEPTH: "1",
        SPUR_SIDECAR_NAME: "dev",
      },
    });

    const previewAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--preview`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(previewAlive).toBe(true);

    const nestedDepth = await pollUntil(
      async () =>
        (
          await readFile(
            sidecarDepthPath(spawned.worktreePath, spawned.id, "preview"),
            "utf8",
          ).catch(() => "")
        ).trim(),
      {
        timeoutMs: 10_000,
        accept: (value) => value === "2",
      },
    );
    expect(nestedDepth).toBe("2");
  });

  it("spur-sidecar helper rejects callers already inside a nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-helper-reject-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = await writeSidecarDepthRecorder(context, "record-nested-sidecar.sh");
    const configPath = await context.writeConfig(
      "sidecar-helper-reject.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
        autoStart: true
      preview:
        command: "${recorderPath}"
      worker:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar reject test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const helperPath = sessionSidecarHelperPath(context, spawned.id);
    await execFileAsync(helperPath, ["--name", "preview", "--json"], {
      cwd: spawned.worktreePath,
      env: {
        ...context.env,
        SPUR_SESSION: spawned.id,
        SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", spawned.id),
        SPUR_SIDECAR_DEPTH: "1",
        SPUR_SIDECAR_NAME: "dev",
      },
    });

    await expect(
      execFileAsync(helperPath, ["--name", "worker", "--json"], {
        cwd: spawned.worktreePath,
        env: {
          ...context.env,
          SPUR_SESSION: spawned.id,
          SPUR_SESSION_TOOL_DIR: join(context.dataDir, "session-tools", spawned.id),
          SPUR_SIDECAR_DEPTH: "2",
          SPUR_SIDECAR_NAME: "preview",
        },
      }),
    ).rejects.toThrow("Sidecars can nest only one level deep");
    expect(await tmuxSessionExists(`${spawned.id}--worker`)).toBe(false);

    const rejectedEvent = await pollUntil(
      async () =>
        readEventLog(context.dataDir).find(
          (entry) =>
            entry.event === "session.sidecar.start_rejected" &&
            entry.sessionId === spawned.id &&
            entry.details?.["sidecarName"] === "worker",
        ),
      {
        timeoutMs: 10_000,
        accept: (value) => Boolean(value),
      },
    );
    expect(rejectedEvent).toMatchObject({
      details: expect.objectContaining({
        callerSidecarDepth: 2,
        callerSidecarName: "preview",
        reason: "max_depth_exceeded",
        sidecarName: "worker",
      }),
      event: "session.sidecar.start_rejected",
    });
  });

  it("POST /sessions/:id/sidecars/:name/start allows one nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-api-nested-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = await writeSidecarDepthRecorder(context, "record-api-sidecar.sh");
    const configPath = await context.writeConfig(
      "sidecar-api-nested.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
        autoStart: true
      preview:
        command: "${recorderPath}"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar api test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/preview/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callerSidecarDepth: 1, callerSidecarName: "dev" }),
    });

    const previewAlive = await pollUntil(() => tmuxSessionExists(`${spawned.id}--preview`), {
      timeoutMs: 10_000,
      accept: (value) => value === true,
    });
    expect(previewAlive).toBe(true);

    const nestedDepth = await pollUntil(
      async () =>
        (
          await readFile(
            sidecarDepthPath(spawned.worktreePath, spawned.id, "preview"),
            "utf8",
          ).catch(() => "")
        ).trim(),
      {
        timeoutMs: 10_000,
        accept: (value) => value === "2",
      },
    );
    expect(nestedDepth).toBe("2");
  });

  it("POST /sessions/:id/sidecars/:name/start rejects callers already inside a nested sidecar", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-api-reject-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "sidecar-api-reject.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
      preview:
        command: "tail -f /dev/null"
      worker:
        command: "tail -f /dev/null"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "nested sidecar api reject test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    await expect(
      context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/worker/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callerSidecarDepth: 2, callerSidecarName: "preview" }),
      }),
    ).rejects.toThrow("Sidecars can nest only one level deep");
    expect(await tmuxSessionExists(`${spawned.id}--worker`)).toBe(false);
  });

  it("spawn with autoStart: true creates the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-autostart-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-autostart.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server autostart test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${spawned.id}--dev`;
    const devSessionAlive = await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (v) => v === true,
    });
    const sidecarEvents = readEventLog(context.dataDir)
      .map((e) => e.event)
      .filter((ev) => typeof ev === "string" && ev.startsWith("session.sidecar"));
    expect(sidecarEvents).toContain("session.sidecar.started");
    expect(devSessionAlive).toBe(true);
  });

  it("reserves sidecar ports per live session and releases them after cleanup", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-reserved-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await writeReservedPortSidecarConfig(context, {
      configName: "sidecar-reserved-ports.yaml",
      sessionPrefix,
      serverPort: port,
      rangeStart: 4600,
      rangeEnd: 4601,
    });
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const first = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "first", "--json"])).stdout,
    ) as SessionView;
    const second = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "second", "--json"])).stdout,
    ) as SessionView;

    const firstPort = await pollUntil(
      async () => readFile(sidecarPortPath(context.repoDir, first.id), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    const secondPort = await pollUntil(
      async () => readFile(sidecarPortPath(context.repoDir, second.id), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );

    expect(new Set([firstPort.trim(), secondPort.trim()])).toEqual(new Set(["4600", "4601"]));

    await context.execCli(["--config", configPath, "kill", first.id, "--force", "--json"]);

    const third = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "third", "--json"])).stdout,
    ) as SessionView;
    const thirdPort = await pollUntil(
      async () => readFile(sidecarPortPath(context.repoDir, third.id), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    expect(thirdPort.trim()).toBe("4600");
  });

  it("real sidecar HTTP probe publishes a link and complete or kill removes it", async () => {
    const port = await findFreePort();
    const reservedRange = await findConsecutiveFreePorts();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-link-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const sidecarPath = await writeSidecarHttpServer(context);
    const configPath = await context.writeConfig(
      "sidecar-link-publish.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      dev:
        command: "node ${sidecarPath}"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: ${reservedRange.start}
            end: ${reservedRange.end}
            url: "http://127.0.0.1"
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    for (const action of ["complete", "kill"] as const) {
      const spawned = await context.fetchJson<SessionView>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          project: "api",
          prompt: `sidecar link ${action}`,
        }),
      });

      const withLink = await pollUntil(
        () => context.fetchJson<SessionView>(`/sessions/${spawned.id}`),
        {
          timeoutMs: 15_000,
          accept: (session) =>
            session.slots?.links.some(
              (link) => link.label === "dev" && link.url.startsWith("http://127.0.0.1:"),
            ) === true,
        },
      );
      expect(withLink.slots?.links.some((link) => link.label === "dev")).toBe(true);

      // Wait for the fixture to actually resolve the session's seeded Spur
      // ToDo item before completing — the sidecar link landing is unrelated
      // to the fixture's backgrounded add-then-complete todo round trip
      // (record_fixture_todo in helpers/runtime.ts), so completing right
      // after the link appears can still 409 on an open item that hasn't
      // landed yet.
      await waitForCleanTodoLedger(context, spawned.id);

      const closed =
        action === "complete"
          ? await context.fetchJson<SessionView>(`/sessions/${spawned.id}/complete`, {
              method: "POST",
            })
          : await context.fetchJson<SessionView>(`/sessions/${spawned.id}/kill`, {
              method: "POST",
              body: JSON.stringify({ force: true }),
            });

      expect(closed.slots?.links.some((link) => link.label === "dev") ?? false).toBe(false);
    }
  });

  it("isolated-daemon sidecar writes isolated artifacts and sibling sidecar uses its wrapper", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-isolated-daemon-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const isolatedDaemonPath = join(
      CLI_PATH,
      "..",
      "..",
      "..",
      "scripts",
      "spur-isolated-daemon.sh",
    );
    const siblingProbePath = await writeIsolatedDaemonSiblingProbe(context);
    const projectConfigDir = join(context.rootDir, "UPPER-CONFIG-PATH");
    await mkdir(projectConfigDir, { recursive: true });
    const projectConfigPath = join(projectConfigDir, "isolated-source-project.yaml");
    await writeFile(
      projectConfigPath,
      `projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
    symlinks:
      - .env
`,
      "utf8",
    );
    const configPath = await context.writeConfig(
      "isolated-daemon-sidecar.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      isolated-daemon:
        command: "bash ${isolatedDaemonPath}"
        autoStart: true
        env:
          SPUR_PROJECT_CONFIG_PATH: ${projectConfigPath}
        ports:
          daemon:
            env: SPUR_RESERVED_PORT_DAEMON
            start: 4320
            end: 4399
      sibling:
        command: "${siblingProbePath}"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = await context.fetchJson<SessionView>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        project: "api",
        prompt: "isolated daemon sidecar test",
      }),
    });
    const toolDir = join(context.dataDir, "session-tools", spawned.id);
    const siblingListPath = join(spawned.worktreePath, `.sibling-isolated-list-${spawned.id}`);
    const siblingEnvPath = join(spawned.worktreePath, `.sibling-isolated-env-${spawned.id}`);
    const branchValidStatusPath = join(
      spawned.worktreePath,
      `.sibling-isolated-branch-valid-status-${spawned.id}`,
    );
    const branchValidOutputPath = join(
      spawned.worktreePath,
      `.sibling-isolated-branch-valid-${spawned.id}`,
    );
    const branchInvalidStatusPath = join(
      spawned.worktreePath,
      `.sibling-isolated-branch-invalid-status-${spawned.id}`,
    );
    const branchInvalidOutputPath = join(
      spawned.worktreePath,
      `.sibling-isolated-branch-invalid-${spawned.id}`,
    );

    await pollUntil(async () => existsSync(join(toolDir, "isolated-env.sh")), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    await pollUntil(async () => existsSync(join(toolDir, "spur-isolated")), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    const siblingList = await pollUntil(
      async () => readFile(siblingListPath, "utf8").catch(() => ""),
      { timeoutMs: 20_000, accept: (value) => value.trim().startsWith("[") },
    );
    const siblingEnv = await pollUntil(
      async () => readFile(siblingEnvPath, "utf8").catch(() => ""),
      { timeoutMs: 20_000, accept: (value) => value.includes("isolated-env.sh") },
    );
    await pollUntil(async () => existsSync(branchInvalidStatusPath), {
      timeoutMs: 20_000,
      accept: (value) => value === true,
    });
    const isolatedEnv = await readFile(join(toolDir, "isolated-env.sh"), "utf8");
    const outerWrapper = await readFile(join(toolDir, "spur"), "utf8");
    const branchValidStatus = (await readFile(branchValidStatusPath, "utf8")).trim();
    const branchValidOutput = await readFile(branchValidOutputPath, "utf8");
    const branchInvalidStatus = (await readFile(branchInvalidStatusPath, "utf8")).trim();
    const branchInvalidOutput = await readFile(branchInvalidOutputPath, "utf8");

    expect(siblingList.trim()).toBe("[]");
    expect(siblingEnv).toContain("isolated-env.sh");
    expect(isolatedEnv).toContain("SPUR_ISOLATED_CONFIG=");
    expect(isolatedEnv).toContain("SPUR_ISOLATED_DAEMON_URL=");
    expect(branchValidStatus, branchValidOutput).toBe("0");
    expect(branchInvalidStatus).not.toBe("0");
    expect(branchInvalidOutput).toContain(
      'branch "Bad_Branch.Name" must match ^feature/[a-z]+(-[a-z]+){0,3}$',
    );
    expect(outerWrapper).toContain(`--config '${configPath}'`);
    expect(outerWrapper).not.toContain("spur-isolated-daemon.");
  });

  it("starting isolated-ui starts isolated-daemon dependency first", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-isolated-ui-dep-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const isolatedDaemonPath = await writeIsolatedDaemonDependencyProbe(context);
    const isolatedUiProbePath = await writeIsolatedUiDependencyProbe(context);
    const configPath = await context.writeConfig(
      "isolated-ui-dependency.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      isolated-daemon:
        command: "${isolatedDaemonPath}"
        autoStart: false
      isolated-ui:
        command: "${isolatedUiProbePath}"
        autoStart: false
        dependsOn:
          - isolated-daemon
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = await context.fetchJson<SessionView>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        project: "api",
        prompt: "isolated ui dependency sidecar test",
      }),
    });

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/sidecars/isolated-ui/start`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const toolDir = join(context.dataDir, "session-tools", spawned.id);
    await pollUntil(async () => existsSync(join(toolDir, "isolated-env.sh")), {
      timeoutMs: 15_000,
      accept: (value) => value === true,
    });
    await pollUntil(
      async () =>
        readFile(join(spawned.worktreePath, `.isolated-ui-env-${spawned.id}`), "utf8").catch(
          () => "",
        ),
      { timeoutMs: 20_000, accept: (value) => value.includes("isolated-env.sh") },
    );

    expect(await tmuxSessionExists(`${spawned.id}--isolated-daemon`)).toBe(true);
    expect(await tmuxSessionExists(`${spawned.id}--isolated-ui`)).toBe(true);
  });

  it("skips an OS-bound reserved sidecar port and still fails when metadata plus the bound port exhaust the range", async () => {
    const port = await findFreePort();
    const reservedRange = await findConsecutiveFreePorts();
    const occupiedServer = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const freePortGuard = createServer();
    await listenOnAllInterfaces(occupiedServer, reservedRange.start);
    try {
      await listenOnAllInterfaces(freePortGuard, reservedRange.end);
    } catch (error) {
      await closeServer(occupiedServer);
      throw error;
    }

    try {
      const context = await createRuntimeTestContext(port);
      const sessionPrefix = `rt-sidecar-os-bound-${port}`;
      activeContexts.push({ context, sessionPrefix });
      await syncTmuxEnvironment({
        HOME: context.env.HOME,
        PATH: context.env.PATH,
        SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
        SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
      });
      const configPath = await writeReservedPortSidecarConfig(context, {
        configName: "sidecar-os-bound-port.yaml",
        sessionPrefix,
        serverPort: port,
        rangeStart: reservedRange.start,
        rangeEnd: reservedRange.end,
      });
      const daemon = await context.startDaemon(configPath);
      currentActiveContext().daemonPid = daemon.info.pid;
      await closeServer(freePortGuard);

      const first = JSON.parse(
        (await context.execCli(["--config", configPath, "spawn", "api", "first", "--json"])).stdout,
      ) as SessionView;
      const firstPort = await pollUntil(
        async () => readFile(sidecarPortPath(context.repoDir, first.id), "utf8").catch(() => ""),
        { timeoutMs: 30_000, accept: (value) => value.trim() === String(reservedRange.end) },
      );
      expect(firstPort.trim()).toBe(String(reservedRange.end));

      const second = JSON.parse(
        (await context.execCli(["--config", configPath, "spawn", "api", "second", "--json"]))
          .stdout,
      ) as SessionView;

      expect(readEventLog(context.dataDir).map((entry) => entry.event)).toContain(
        "session.sidecar.autostart.failed",
      );
      await expectSidecarPortConflict(
        context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
          method: "POST",
        }),
        {
          code: "sidecar_port_busy",
          sidecarName: "dev",
          candidates: [
            {
              portId: "http",
              env: "SPUR_RESERVED_PORT_DEV",
              port: reservedRange.start,
              owner: "external",
            },
            {
              portId: "http",
              env: "SPUR_RESERVED_PORT_DEV",
              port: reservedRange.end,
              owner: first.id,
            },
          ],
        },
      );

      await closeServer(occupiedServer);
      await context.execCli(["--config", configPath, "kill", first.id, "--force", "--json"]);
      await context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
        method: "POST",
      });
      const secondPort = await pollUntil(
        async () => readFile(sidecarPortPath(context.repoDir, second.id), "utf8").catch(() => ""),
        { timeoutMs: 30_000, accept: (value) => value.trim() === String(reservedRange.start) },
      );
      expect(secondPort.trim()).toBe(String(reservedRange.start));
    } finally {
      await closeServer(freePortGuard);
      await closeServer(occupiedServer);
    }
  });

  it("keeps spawn running when no reserved sidecar ports remain and allows manual retry later", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-ports-full-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await writeReservedPortSidecarConfig(context, {
      configName: "sidecar-reserved-ports-full.yaml",
      sessionPrefix,
      serverPort: port,
      rangeStart: 4700,
      rangeEnd: 4700,
    });
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const first = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "first", "--json"])).stdout,
    ) as SessionView;
    const second = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "second", "--json"])).stdout,
    ) as SessionView;

    await pollUntil(
      async () => readFile(sidecarPortPath(context.repoDir, first.id), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim() === "4700" },
    );
    expect(readEventLog(context.dataDir).map((entry) => entry.event)).toContain(
      "session.sidecar.autostart.failed",
    );

    await expectSidecarPortConflict(
      context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
        method: "POST",
      }),
      {
        code: "sidecar_port_busy",
        sidecarName: "dev",
        candidates: [
          {
            portId: "http",
            env: "SPUR_RESERVED_PORT_DEV",
            port: 4700,
            owner: first.id,
          },
        ],
      },
    );

    await context.execCli(["--config", configPath, "kill", first.id, "--force", "--json"]);
    await context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
      method: "POST",
    });
    const secondPort = await pollUntil(
      async () => readFile(sidecarPortPath(context.repoDir, second.id), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    expect(secondPort.trim()).toBe("4700");
  });

  it("kill cleans up the --dev tmux session", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-devserver-kill-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "devserver-kill.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
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
      dev:
        command: "tail -f /dev/null"
        autoStart: true
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "dev server kill test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${spawned.id}--dev`;

    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (v) => v === true,
    });

    await context.fetchJson<SessionView>(`/sessions/${spawned.id}/kill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    const devSessionGone = !(await tmuxSessionExists(devSessionName));
    expect(devSessionGone).toBe(true);
  });

  it("pause cleans up the sidecar tmux session and keeps the workspace", async () => {
    const port = await findFreePort();
    const context = await createRuntimeTestContext(port);
    const sessionPrefix = `rt-sidecar-pause-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const recorderPath = join(context.repoDir, "record-pause-sidecar-port.sh");
    await writeFile(
      recorderPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SPUR_RESERVED_PORT_DEV:-}" > ".sidecar-port-\${SPUR_SESSION:?}"
tail -f /dev/null
`,
      "utf8",
    );
    await chmod(recorderPath, 0o755);
    const configPath = await context.writeConfig(
      "sidecar-pause.yaml",
      `server:
  host: 127.0.0.1
  port: ${port}
dataDir: ${context.dataDir}
worktreeDir: ${context.worktreeDir}
defaultAgent: claude
projects:
  api:
    path: ${context.repoDir}
    defaultBranch: main
    sessionPrefix: ${sessionPrefix}
    worktree: false
    symlinks:
      - .env
    sidecars:
      dev:
        command: "${recorderPath}"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 4800
            end: 4800
`,
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const first = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "sidecar pause test",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    const devSessionName = `${first.id}--dev`;

    await pollUntil(() => tmuxSessionExists(devSessionName), {
      timeoutMs: 15_000,
      accept: (v) => v === true,
    });

    const paused = JSON.parse(
      (await context.execCli(["--config", configPath, "pause", first.id, "--json"])).stdout,
    ) as SessionView;
    expect(paused.status).toBe("stopped");
    expect(paused.workspaceExists).toBe(true);

    const devSessionGone = !(await tmuxSessionExists(devSessionName));
    expect(devSessionGone).toBe(true);
    expect(existsSync(first.worktreePath)).toBe(true);

    const second = JSON.parse(
      (await context.execCli(["--config", configPath, "spawn", "api", "sidecar retry", "--json"]))
        .stdout,
    ) as SessionView;
    await context.fetchJson<SessionView>(`/sessions/${second.id}/sidecars/dev/start`, {
      method: "POST",
    });
    const secondPort = await pollUntil(
      async () =>
        readFile(join(second.worktreePath, `.sidecar-port-${second.id}`), "utf8").catch(() => ""),
      { timeoutMs: 15_000, accept: (value) => value.trim().length > 0 },
    );
    expect(secondPort.trim()).toBe("4800");
  });
});

// Linux-only: the post-condition below reads /proc/<pid>/environ directly
// (process-tree.ts's readProcessEnvValue), which has no portable equivalent.
describe.skipIf(!tmuxOk || platform() !== "linux")("duplicate-agent guard (runtime)", () => {
  afterEach(async () => {
    while (activeContexts.length > 0) {
      const current = popActiveContext();
      await stopDaemonByPid(current.daemonPid);
      if (current.controllerSessionName) {
        await killTmuxSession(current.controllerSessionName);
      }
      await killTmuxSessionsByPrefix(current.sessionPrefix, current.context.tmuxSocketName);
      await current.context.cleanup();
    }
  });

  it("restore leaves exactly one agent process for the session", async () => {
    const port = await findFreePort();
    // hupResistantAgents: the fake claude script ignores SIGHUP the same
    // way pause()/restore() now must tolerate a real agent doing —
    // proving killAgentPaneAndConfirmExit's escalation (HUP -> TERM ->
    // KILL) actually lands on a real process tree, not just a mock.
    const context = await createRuntimeTestContext(port, { hupResistantAgents: true });
    const sessionPrefix = `rt-dup-${port}`;
    activeContexts.push({ context, sessionPrefix });
    await syncTmuxEnvironment({
      HOME: context.env.HOME,
      PATH: context.env.PATH,
      SPUR_FAKE_AGENT_LOG_DIR: context.agentLogDir,
      SPUR_FAKE_GH_STATE_FILE: context.ghStateFile,
    });
    const configPath = await context.writeConfig(
      "dup-guard.yaml",
      baseConfig(context, sessionPrefix),
    );
    const daemon = await context.startDaemon(configPath);
    currentActiveContext().daemonPid = daemon.info.pid;

    const spawned = JSON.parse(
      (
        await context.execCli([
          "--config",
          configPath,
          "spawn",
          "api",
          "duplicate guard runtime prompt",
          "--json",
        ])
      ).stdout,
    ) as SessionView;

    // Scoped to the AGENT process specifically (args matching the "claude"
    // binary), not every process in the pane: the pane's own login shell
    // also inherits SPUR_SESSION but is never the agent, so a blind
    // SPUR_SESSION-only scan would always see 2 (the pane shell plus the
    // real agent) and could never assert "exactly one agent".
    function isClaudeAgentProcess(args: string): boolean {
      return /(?:^|\/|\s)claude(?:\s|$)/.test(args);
    }

    async function findSessionAgentPids(sessionId: string): Promise<number[]> {
      const processes = await listProcesses();
      const matches: number[] = [];
      for (const proc of processes) {
        if (!isClaudeAgentProcess(proc.args)) continue;
        const envRead = await readProcessEnvValue(proc.pid, "SPUR_SESSION");
        if (envRead.status === "ok" && envRead.value === sessionId) {
          matches.push(proc.pid);
        }
      }
      return matches;
    }

    const preTeardownPids = await pollUntil(() => findSessionAgentPids(spawned.id), {
      timeoutMs: 15_000,
      accept: (pids) => pids.length > 0,
    });
    expect(preTeardownPids.length).toBeGreaterThan(0);
    const [preTeardownPid] = preTeardownPids;
    if (preTeardownPid === undefined) {
      throw new Error("expected at least one agent pid before teardown");
    }

    // Pause is the real end-to-end exercise of the HUP-resistant escalation:
    // it now routes through the same killAgentPaneAndConfirmExit restore()
    // uses, so this proves the real signal sequence (HUP ignored, TERM
    // lands) actually terminates a resistant process, not just a mock.
    await context.execCli(["--config", configPath, "pause", spawned.id, "--json"]);
    await pollUntil(() => processExists(preTeardownPid), {
      timeoutMs: 15_000,
      accept: (alive) => alive === false,
    });
    expect(await processExists(preTeardownPid)).toBe(false);

    await context.fetchJson(`/sessions/${spawned.id}/restore`, { method: "POST" });

    const postRestorePids = await pollUntil(() => findSessionAgentPids(spawned.id), {
      timeoutMs: 15_000,
      accept: (pids) => pids.length === 1,
    });
    expect(postRestorePids).toHaveLength(1);
    expect(postRestorePids).not.toContain(preTeardownPid);
    expect(await processExists(preTeardownPid)).toBe(false);
  });
});
