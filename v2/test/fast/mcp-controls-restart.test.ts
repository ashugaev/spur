import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it, vi } from "vitest";
import { startMcpHttp } from "../../src/mcp-http.js";
import { writeSession, readSession } from "../../src/metadata.js";
import { readUserActionLog } from "../../src/user-action-log.js";
import { codexHookHomePath } from "../../src/agents/codex.js";
import { readLiveProcessStarttime } from "../../src/sidecars/reap.js";
import { createTempDir, execFileAsync, findFreePort } from "../helpers/common.js";

async function sourceSnapshot(): Promise<Record<string, string>> {
  const directory = fileURLToPath(new URL("../../src/", import.meta.url));
  const v2 = fileURLToPath(new URL("../../", import.meta.url));
  const names = [
    ...(await readdir(directory, { recursive: true }))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/${name}`),
    "test/fixtures/mcp-controls-daemon.ts",
    "test/fast/mcp-controls-restart.test.ts",
  ].sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        `v2/${name}`,
        createHash("sha256")
          .update(await readFile(join(v2, name)))
          .digest("hex"),
      ]),
    ),
  );
}

it("restarts only an owned backend, retains session/history/queue/wake and resolves the original receipt after MCP reconnect", async () => {
  const root = await createTempDir("mcp-owned-restart-");
  const home = join(root, "home");
  const data = join(root, "data");
  const repo = join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  const bin = join(root, "bin");
  const tmuxDirectory = join(root, "tmux");
  await mkdir(bin);
  await mkdir(tmuxDirectory);
  for (const command of ["tmux", "git", "ps", "id", "getconf"]) {
    await symlink(`/usr/bin/${command}`, join(bin, command));
  }
  await symlink(process.execPath, join(bin, "node"));
  const environment = {
    PATH: bin,
    HOME: home,
    TMPDIR: root,
    TMUX_TMPDIR: tmuxDirectory,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    SPUR_DISABLE_AUTOSTART: "1",
    SPUR_MCP_TUNNEL_ENV_FILE: join(home, "absent-tunnel.env"),
  };
  const config = join(root, "instance.yaml");
  const ports = new Set<number>();
  while (ports.size < 3) ports.add(await findFreePort());
  const [daemonPort, mcpPort, uiPort] = [...ports];
  const socketName = `mcp-owned-${randomUUID()}`;
  const sentinelName = "owned-live-sentinel";
  const tmux = (args: string[]) =>
    execFileAsync("/usr/bin/tmux", ["-L", socketName, ...args], { cwd: root, env: environment });
  const paneIdentity = async () => {
    const { stdout } = await tmux([
      "display-message",
      "-p",
      "-t",
      `=${sentinelName}:`,
      "#{pane_pid} #{pane_dead}",
    ]);
    const [pidText, dead] = stdout.trim().split(" ");
    const pid = Number(pidText);
    const starttime = await readLiveProcessStarttime(pid);
    if (!Number.isInteger(pid) || pid <= 0 || dead !== "0" || starttime === null)
      throw new Error("Owned live sentinel identity unavailable");
    await tmux(["has-session", "-t", `=${sentinelName}`]);
    return { pid, starttime, dead: false, session: sentinelName, socketName };
  };
  if (!daemonPort || !mcpPort || !uiPort || ports.has(4310) || ports.has(4311) || ports.has(5555))
    throw new Error("Owned non-production ports required");
  await writeFile(
    config,
    `server:\n  host: 127.0.0.1\n  port: ${daemonPort}\nmcp:\n  port: ${mcpPort}\nui:\n  port: ${uiPort}\ndataDir: ${data}\nworktreeDir: ${join(root, "worktrees")}\ntmux:\n  socketName: ${socketName}\nprojects:\n  owned:\n    path: ${repo}\n`,
  );
  const scheduledWake = { dueAt: "2099-01-01T00:00:00.000Z", message: "owned future wake" };
  const queuedMessages = { messages: ["owned queued message"], awaitingPrompt: false };
  writeSession(data, {
    id: "owned-session",
    project: "owned",
    agent: "codex",
    prompt: "owned fixture",
    branch: "feature/owned",
    worktree: false,
    worktreePath: repo,
    tmuxSession: "owned-session",
    launchCommand: "codex",
    status: "stopped",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    scheduledWake,
    queuedMessages,
  });
  writeSession(data, {
    id: "owned-live",
    project: "owned",
    agent: "codex",
    prompt: "Provider-free process preservation sentinel",
    branch: "feature/owned",
    worktree: false,
    worktreePath: repo,
    tmuxSession: sentinelName,
    launchCommand: process.execPath,
    status: "running",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  });
  const rolloutDir = join(
    codexHookHomePath(join(data, "session-tools", "owned-session")),
    "sessions",
  );
  await mkdir(rolloutDir, { recursive: true });
  const historyPath = join(rolloutDir, "rollout-owned.jsonl");
  const history =
    [
      { type: "session_meta", payload: { id: "owned-session", cwd: repo } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "owned question" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "owned answer" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await writeFile(historyPath, history);
  const require = createRequire(new URL("../../../packages/web/package.json", import.meta.url));
  const tsx = require.resolve("tsx");
  const fixture = fileURLToPath(new URL("../fixtures/mcp-controls-daemon.ts", import.meta.url));
  let child: ChildProcess | undefined;
  let supervise = true;
  let restartAuthorized = false;
  let generation = 0;
  let startup: Promise<void>;
  const childOutput: string[] = [];
  const childExits: {
    pid: number | undefined;
    code: number | null;
    signal: NodeJS.Signals | null;
  }[] = [];
  const startChild = (): Promise<void> => {
    generation++;
    const owned = spawn(process.execPath, ["--import", tsx, fixture, config], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...environment, SPUR_CONFIG: config },
    });
    child = owned;
    owned.stdout?.on("data", (chunk: Buffer) => childOutput.push(chunk.toString()));
    owned.stderr?.on("data", (chunk: Buffer) => childOutput.push(chunk.toString()));
    owned.once("exit", (code, signal) => {
      childExits.push({ pid: owned.pid, code, signal });
      if (supervise && restartAuthorized && generation === 1) {
        startup = startChild();
        void startup.catch(() => undefined);
      }
    });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned daemon startup timeout")), 15000);
      owned.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
      owned.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      owned.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Owned daemon exited before readiness"));
      });
    });
  };
  vi.stubEnv("SPUR_DISABLE_AUTOSTART", "1");
  vi.stubEnv("SPUR_MCP_TUNNEL_ENV_FILE", join(home, "absent-tunnel.env"));
  let host: Awaited<ReturnType<typeof startMcpHttp>> | undefined;
  let client: Client | undefined;
  const connect = async () => {
    const connection = new Client({ name: "owned-restart-proof", version: "1" });
    await connection.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mcpPort}/mcp`),
      ) as unknown as Transport,
    );
    client = connection;
    return connection;
  };
  const evidence: Record<string, unknown> = {
    ownedRoot: root,
    ports: { daemonPort, mcpPort, uiPort },
    privateHome: home,
  };
  const sourceBefore = await sourceSnapshot();
  let sentinel: Awaited<ReturnType<typeof paneIdentity>> | undefined;
  try {
    await tmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      sentinelName,
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    sentinel = await paneIdentity();
    startup = startChild();
    await startup;
    host = await startMcpHttp(config);
    const first = await connect();
    const before = await first.callTool({ name: "mcp_status", arguments: {} });
    const daemonLogs = await first.callTool({ name: "read_daemon_logs", arguments: {} });
    expect(daemonLogs.structuredContent).toMatchObject({
      source: "daemon-event-journal",
      status: "available",
    });
    expect(JSON.stringify(daemonLogs)).toContain("daemon.started");
    const runtimeDiagnostics = await first.callTool({
      name: "read_daemon_logs",
      arguments: { source: "runtime" },
    });
    expect(runtimeDiagnostics.structuredContent).toMatchObject({
      source: "daemon-runtime-diagnostics",
      status: "available",
    });
    expect(JSON.stringify(runtimeDiagnostics)).toContain("gh not found on PATH");
    const beforeHistory = await first.callTool({
      name: "get_conversation",
      arguments: { sessionId: "owned-session", view: "messages" },
    });
    expect(JSON.stringify(beforeHistory)).toContain("owned answer");
    const prStatus = await first.callTool({
      name: "get_session_pr_status",
      arguments: { sessionId: "owned-session" },
    });
    expect(prStatus.structuredContent).toMatchObject({ status: "missing", refreshed: false });
    const operationId = randomUUID();
    restartAuthorized = true;
    const accepted = await first.callTool({ name: "restart_daemon", arguments: { operationId } });
    expect(accepted.structuredContent).toMatchObject({
      duplicate: false,
      receipt: { operationId, action: "daemon.restart", status: "accepted" },
    });
    await first.close();
    client = undefined;
    await host.close();
    host = undefined;
    host = await startMcpHttp(config);
    const reconnected = await connect();
    const duplicate = await reconnected.callTool({
      name: "restart_daemon",
      arguments: { operationId },
    });
    expect(duplicate.structuredContent).toMatchObject({
      duplicate: true,
      receipt: { operationId },
    });
    let resolved: unknown;
    await vi.waitFor(
      async () => {
        const response = await reconnected.callTool({
          name: "get_daemon_restart",
          arguments: { operationId },
        });
        resolved = response.structuredContent;
        expect(resolved).toMatchObject({
          status: "completed",
          receipt: { operationId, status: "completed" },
          daemonAvailable: true,
        });
      },
      { timeout: 20000, interval: 250 },
    );
    const after = await reconnected.callTool({ name: "mcp_status", arguments: {} });
    expect(generation).toBe(2);
    const sentinelAfter = await paneIdentity();
    expect(sentinelAfter).toEqual(sentinel);
    expect(before.structuredContent?.daemon).not.toEqual(after.structuredContent?.daemon);
    expect(readSession(data, "owned-session")).toMatchObject({
      status: "stopped",
      scheduledWake,
      queuedMessages,
    });
    expect(await readFile(historyPath, "utf8")).toBe(history);
    const afterHistory = await reconnected.callTool({
      name: "get_conversation",
      arguments: { sessionId: "owned-session", view: "messages" },
    });
    expect(JSON.stringify(afterHistory)).toContain("owned answer");
    expect(
      readUserActionLog(data).filter((entry) => entry.action === "daemon.restart"),
    ).toHaveLength(1);
    Object.assign(evidence, {
      before: before.structuredContent,
      accepted: accepted.structuredContent,
      duplicate: duplicate.structuredContent,
      resolved,
      after: after.structuredContent,
      generations: generation,
      daemonLogs: daemonLogs.structuredContent,
      runtimeDiagnostics: runtimeDiagnostics.structuredContent,
      prStatus: prStatus.structuredContent,
      sentinelBefore: sentinel,
      sentinelAfter,
      preserved: [
        "stopped-session",
        "owned-codex-jsonl-fixture",
        "queued-messages",
        "scheduled-wake",
      ],
      historySha256: createHash("sha256").update(history).digest("hex"),
    });
  } finally {
    supervise = false;
    const networkCleanup = await Promise.allSettled([client?.close(), host?.close()]);
    const owned = child;
    let childTerminal: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let cleanupError: unknown;
    let sentinelStopped = sentinel === undefined;
    try {
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => owned.once("exit", (code, signal) => resolve({ code, signal })),
        );
        const force = setTimeout(() => owned.kill("SIGKILL"), 5000);
        let deadline: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Owned child exit was not observed")),
            10000,
          );
        });
        owned.kill("SIGTERM");
        try {
          childTerminal = await Promise.race([exited, timedOut]);
        } finally {
          clearTimeout(force);
          clearTimeout(deadline);
        }
      } else if (owned) {
        childTerminal = { code: owned.exitCode, signal: owned.signalCode };
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        if (sentinel) {
          await tmux(["kill-server"]);
          await vi.waitFor(
            async () =>
              expect(await readLiveProcessStarttime(sentinel.pid)).not.toBe(sentinel.starttime),
            { timeout: 5000 },
          );
          sentinelStopped = true;
        }
      } catch (error) {
        cleanupError ??= error;
      } finally {
        vi.unstubAllEnvs();
      }
    }
    const sourceAfter = await sourceSnapshot();
    Object.assign(evidence, {
      childOutput,
      childExits,
      sourceBefore,
      sourceAfter,
      sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
      cleanup: {
        childPid: owned?.pid,
        childTerminal,
        childExitObserved: childTerminal !== undefined,
        sentinelStopped,
        networkClosed: networkCleanup.every((item) => item.status === "fulfilled"),
        error: cleanupError instanceof Error ? cleanupError.message : null,
      },
    });
    if (process.env.SPUR_SESSION_ARTIFACTS_DIR)
      await writeFile(
        join(process.env.SPUR_SESSION_ARTIFACTS_DIR, "isolated-restart-proof.json"),
        JSON.stringify(evidence, null, 2),
      );
    expect(cleanupError).toBeUndefined();
    expect(childTerminal).toBeDefined();
    expect(sentinelStopped).toBe(true);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(networkCleanup.every((item) => item.status === "fulfilled")).toBe(true);
  }
}, 45000);
