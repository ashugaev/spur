import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { createTempDir, findFreePort } from "../helpers/common.js";

it("restarts only an owned backend, retains session/history/queue/wake and resolves the original receipt after MCP reconnect", async () => {
  const root = await createTempDir("mcp-owned-restart-");
  const home = join(root, "home");
  const data = join(root, "data");
  const repo = join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  const config = join(root, "instance.yaml");
  const ports = new Set<number>();
  while (ports.size < 3) ports.add(await findFreePort());
  const [daemonPort, mcpPort, uiPort] = [...ports];
  if (!daemonPort || !mcpPort || !uiPort || ports.has(4310) || ports.has(4311) || ports.has(5555))
    throw new Error("Owned non-production ports required");
  await writeFile(
    config,
    `server:\n  host: 127.0.0.1\n  port: ${daemonPort}\nmcp:\n  port: ${mcpPort}\nui:\n  port: ${uiPort}\ndataDir: ${data}\nworktreeDir: ${join(root, "worktrees")}\ntmux:\n  socketName: mcp-owned-${randomUUID()}\nprojects:\n  owned:\n    path: ${repo}\n`,
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
  let generation = 0;
  let startup: Promise<void>;
  const childOutput: string[] = [];
  const startChild = (): Promise<void> => {
    generation++;
    const owned = spawn(process.execPath, ["--import", tsx, fixture, config], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: root,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_CACHE_HOME: join(home, "cache"),
        SPUR_CONFIG: config,
        SPUR_DISABLE_AUTOSTART: "1",
        SPUR_MCP_TUNNEL_ENV_FILE: join(home, "absent-tunnel.env"),
      },
    });
    child = owned;
    owned.stdout?.on("data", (chunk: Buffer) => childOutput.push(chunk.toString()));
    owned.stderr?.on("data", (chunk: Buffer) => childOutput.push(chunk.toString()));
    owned.once("exit", () => {
      if (supervise) {
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
  try {
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
    const beforeHistory = await first.callTool({
      name: "get_conversation",
      arguments: { sessionId: "owned-session", view: "messages" },
    });
    expect(JSON.stringify(beforeHistory)).toContain("owned answer");
    const operationId = randomUUID();
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
    await client?.close();
    await host?.close();
    const owned = child;
    if (owned && owned.exitCode === null) {
      const exited = new Promise<void>((resolve) => owned.once("exit", () => resolve()));
      owned.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (owned.exitCode === null) owned.kill("SIGKILL");
            resolve();
          }, 5000).unref(),
        ),
      ]);
    }
    vi.unstubAllEnvs();
    Object.assign(evidence, {
      childOutput,
      cleanup: "owned backend stopped; no production instance contacted",
    });
    if (process.env.SPUR_SESSION_ARTIFACTS_DIR)
      await writeFile(
        join(process.env.SPUR_SESSION_ARTIFACTS_DIR, "isolated-restart-proof.json"),
        JSON.stringify(evidence, null, 2),
      );
  }
}, 45000);
