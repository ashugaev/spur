import { spawn, ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { startMcpHttp } from "../../src/mcp-http.js";
import { writeSession, readSession } from "../../src/metadata.js";
import { readUserActionLog } from "../../src/user-action-log.js";
import { codexHookHomePath } from "../../src/agents/codex.js";
import { readLiveProcessStarttime } from "../../src/sidecars/reap.js";
import { createTempDir, execFileAsync, findFreePort } from "../helpers/common.js";

type ChildEvidence = {
  generation: number;
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

function observeStartup(
  owned: ChildProcess,
  generation: number,
  childOutput: string[],
  childExits: ChildEvidence[],
  report: (summary: string) => void = (summary) => process.stderr.write(`${summary}\n`),
) {
  const startedAt = Date.now();
  const phases: { generation: number; stage: string; elapsedMs: number }[] = [];
  const observe = (stage: string) =>
    phases.push({ generation, stage, elapsedMs: Date.now() - startedAt });
  observe("awaiting-fixture");
  const evidence: ChildEvidence = {
    generation,
    pid: owned.pid,
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
  };
  for (const stream of ["stdout", "stderr"] as const)
    owned[stream]?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      evidence[stream] += text;
      childOutput.push(text);
    });
  owned.once("exit", (code, signal) => {
    evidence.code = code;
    evidence.signal = signal;
    childExits.push(evidence);
  });
  owned.once("error", (error) => {
    evidence.spawnError = error.stack ?? error.message;
  });
  const closed = new Promise<void>((resolve) =>
    owned.once("close", (code, signal) => {
      evidence.code = code;
      evidence.signal = signal;
      resolve();
    }),
  );
  const startup = new Promise<void>((resolve, reject) => {
    const fail = (category: "exit" | "signal" | "spawn-error" | "timeout") => {
      finish();
      const summary = `Owned daemon startup failed: generation=${generation} code=${evidence.code ?? "none"} signal=${evidence.signal ?? "none"} category=${category} last-observed-stage=${phases.at(-1)?.stage} elapsedMs=${Date.now() - startedAt}`;
      report(summary);
      reject(new Error(summary));
    };
    const onMessage = (message: unknown) => {
      if (
        owned.pid === undefined ||
        typeof message !== "object" ||
        message === null ||
        !("pid" in message) ||
        message.pid !== owned.pid
      )
        return;
      if (
        "startupStage" in message &&
        (message.startupStage === "importing-server" || message.startupStage === "starting-server")
      ) {
        observe(message.startupStage);
        return;
      }
      if (!("ready" in message) || message.ready !== true) return;
      observe("ready");
      finish();
      resolve();
    };
    const close = () =>
      fail(evidence.spawnError ? "spawn-error" : evidence.signal ? "signal" : "exit");
    const timer = setTimeout(() => fail("timeout"), 15000);
    const finish = () => {
      clearTimeout(timer);
      owned.off("message", onMessage);
      owned.off("close", close);
    };
    owned.on("message", onMessage);
    owned.once("close", close);
  });
  // Replacement startup is supervised without an awaiting caller.
  void startup.catch(() => undefined);
  return { startup, closed, evidence, phases };
}

async function awaitChildCloses(closes: Promise<void>[]) {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(closes),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Owned child stream close was not observed")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

async function writePrivateEvidence(path: string, evidence: unknown) {
  const file = await fs.open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(JSON.stringify(evidence, null, 2));
  } finally {
    await file.close();
  }
}

it("waits for owned readiness across progress and invalid IPC messages", async () => {
  const owned = new ChildProcess();
  Object.defineProperty(owned, "pid", { value: 42 });
  const report = vi.fn<(summary: string) => void>();
  const observation = observeStartup(owned, 3, [], [], report);
  let ready = false;
  void observation.startup.then(() => {
    ready = true;
  });
  for (const message of [
    null,
    "private-marker",
    { ready: true },
    { ready: true, pid: 43 },
    { ready: false, pid: 42 },
    { startupStage: "private-marker", pid: 42 },
    { startupStage: "importing-server", pid: 43 },
    { startupStage: "importing-server", pid: 42 },
    { startupStage: "starting-server", pid: 42 },
  ]) {
    owned.emit("message", message);
    await Promise.resolve();
    expect(ready).toBe(false);
  }
  owned.emit("message", { ready: true, pid: 42 });
  await observation.startup;
  expect(ready).toBe(true);
  owned.emit("message", { ready: true, pid: 42 });
  expect(observation.phases.map((phase) => phase.stage)).toEqual([
    "awaiting-fixture",
    "importing-server",
    "starting-server",
    "ready",
  ]);
  for (const phase of observation.phases) {
    expect(phase.generation).toBe(3);
    expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
  }
  expect(report).not.toHaveBeenCalled();
  expect(owned.listenerCount("message")).toBe(0);
  owned.emit("close", 0, null);
  await observation.closed;
});

it("times out at the last owned phase without exposing invalid IPC", async () => {
  vi.useFakeTimers();
  const owned = new ChildProcess();
  const report = vi.fn<(summary: string) => void>();
  const observation = observeStartup(owned, 4, [], [], report);
  try {
    owned.emit("message", { ready: true });
    Object.defineProperty(owned, "pid", { value: 42 });
    owned.emit("message", { startupStage: "importing-server", pid: 42 });
    owned.emit("message", { startupStage: "private-marker", pid: 42 });
    owned.emit("message", { startupStage: "starting-server", pid: 43 });
    await vi.advanceTimersByTimeAsync(14999);
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const failure = await observation.startup.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(report).toHaveBeenCalledTimes(1);
    const summary = report.mock.calls[0]?.[0] ?? "";
    expect((failure as Error).message).toBe(summary);
    expect(summary).toContain("generation=4");
    expect(summary).toContain("category=timeout");
    expect(summary).toContain("last-observed-stage=importing-server");
    expect(summary).toContain("elapsedMs=15000");
    expect(summary).not.toContain("private-marker");
    expect(summary.length).toBeLessThanOrEqual(220);
    expect(owned.listenerCount("message")).toBe(0);
    owned.emit("close", 0, null);
    await observation.closed;
    expect(report).toHaveBeenCalledTimes(1);
  } finally {
    owned.emit("close", 0, null);
    vi.useRealTimers();
  }
});

it.each(["exit", "signal"] as const)(
  "captures private startup %s evidence through close",
  async (mode) => {
    const marker = "private-token-fixture /private/home/example fixture.internal";
    const report = vi.fn<(summary: string) => void>();
    const output: string[] = [];
    const exits: ChildEvidence[] = [];
    const owned = spawn(
      process.execPath,
      [
        "-e",
        `
    process.stdout.write(${JSON.stringify(marker)});
    process.stderr.write('trailing-private-marker', () => {
      ${mode === "exit" ? "process.exit(23)" : "process.kill(process.pid, 'SIGTERM')"};
    });
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const observation = observeStartup(owned, 2, output, exits, report);
    try {
      await observation.closed;
      const failure = await observation.startup.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(observation.evidence).toMatchObject({
        generation: 2,
        code: mode === "exit" ? 23 : null,
        signal: mode === "signal" ? "SIGTERM" : null,
        stdout: marker,
        stderr: "trailing-private-marker",
      });
      expect(exits).toEqual([observation.evidence]);
      expect(output.join("")).toContain("trailing-private-marker");
      expect(report).toHaveBeenCalledTimes(1);
      const summary = report.mock.calls[0]?.[0] ?? "";
      expect(summary).toContain("generation=2");
      expect(summary).toContain(`code=${mode === "exit" ? "23" : "none"}`);
      expect(summary).toContain(`signal=${mode === "signal" ? "SIGTERM" : "none"}`);
      expect(summary).toContain(`category=${mode}`);
      expect(summary.length).toBeLessThanOrEqual(220);
      expect((failure as Error).message).toBe(summary);
      for (const secret of [
        marker,
        "private-token-fixture",
        "/private/home",
        "fixture.internal",
        "trailing-private-marker",
      ])
        expect(summary).not.toContain(secret);
    } finally {
      if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
      await observation.closed;
    }
  },
);

it("waits for every generation's close before securing and replacing private evidence", async () => {
  const root = await createTempDir("mcp-private-evidence-");
  const path = join(root, "proof.json");
  await writeFile(path, "old-private-marker", { mode: 0o664 });
  await fs.chmod(path, 0o664);
  const children = [new ChildProcess(), new ChildProcess()];
  const observations = children.map((owned, index) => {
    owned.stderr = new PassThrough();
    const observation = observeStartup(owned, index + 1, [], [], vi.fn());
    Object.defineProperty(owned, "pid", { value: index + 1 });
    owned.emit("message", { ready: true, pid: owned.pid });
    return observation;
  });
  const probe = await fs.open(path, "r+");
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const truncate = prototype.truncate;
  const truncateSpy = vi.spyOn(prototype, "truncate").mockImplementation(async function (
    this: fs.FileHandle,
    length,
  ) {
    expect((await this.stat()).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("old-private-marker");
    expect(closed).toBe(true);
    await truncate.call(this, length);
  });
  let closed = false;
  try {
    const serialized = awaitChildCloses(observations.map((entry) => entry.closed)).then(
      async () => {
        closed = true;
        await writePrivateEvidence(
          path,
          observations.map((entry) => entry.evidence),
        );
      },
    );
    for (const owned of children) owned.emit("exit", 0, null);
    children[0]?.emit("close", 0, null);
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(truncateSpy).not.toHaveBeenCalled();
    children[1]?.stderr?.emit("data", Buffer.from("last-private-marker"));
    children[1]?.emit("close", 0, null);
    await serialized;
    await Promise.all(observations.map((entry) => entry.startup));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
      observations.map((entry) => entry.evidence),
    );
    expect(observations[1]?.evidence.stderr).toBe("last-private-marker");
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    truncateSpy.mockRestore();
  }
  const link = join(root, "proof-link.json");
  await symlink(path, link);
  await expect(writePrivateEvidence(link, "forbidden")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toContain("last-private-marker");
});

it("bounds an unclosed generation by the existing cleanup deadline", async () => {
  vi.useFakeTimers();
  try {
    const owned = new ChildProcess();
    const observation = observeStartup(owned, 1, [], [], vi.fn());
    Object.defineProperty(owned, "pid", { value: 1 });
    owned.emit("message", { ready: true, pid: owned.pid });
    await observation.startup;
    owned.emit("exit", 0, null);
    const closed = awaitChildCloses([observation.closed]);
    const rejected = expect(closed).rejects.toThrow("Owned child stream close was not observed");
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    owned.emit("close", 0, null);
    await observation.closed;
  } finally {
    vi.useRealTimers();
  }
});

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
  const childExits: ChildEvidence[] = [];
  const observations: ReturnType<typeof observeStartup>[] = [];
  const startChild = (): Promise<void> => {
    generation++;
    const owned = spawn(process.execPath, ["--import", tsx, fixture, config], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...environment, SPUR_CONFIG: config },
    });
    child = owned;
    const observation = observeStartup(owned, generation, childOutput, childExits);
    observations.push(observation);
    owned.once("exit", () => {
      if (supervise && restartAuthorized && generation === 1) {
        startup = startChild();
      }
    });
    return observation.startup;
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
    const initialInfo = await fetch(`http://127.0.0.1:${daemonPort}/info`);
    expect(initialInfo.status).toBe(200);
    expect(await initialInfo.json()).toMatchObject({ pid: child?.pid });
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
    for (const observation of observations) {
      expect(observation.phases.map((phase) => phase.stage)).toEqual([
        "awaiting-fixture",
        "importing-server",
        "starting-server",
        "ready",
      ]);
      for (const phase of observation.phases) expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    const sentinelAfter = await paneIdentity();
    expect(sentinelAfter).toEqual(sentinel);
    const statusSchema = z.object({
      daemon: z.object({ pid: z.number(), lifecycleInstanceId: z.string() }),
    });
    expect(statusSchema.parse(before.structuredContent).daemon).not.toEqual(
      statusSchema.parse(after.structuredContent).daemon,
    );
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
    let streamsClosed = false;
    const force = setTimeout(() => {
      if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
    }, 5000);
    try {
      const closed = awaitChildCloses(observations.map((observation) => observation.closed));
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        owned.kill("SIGTERM");
      }
      await closed;
      streamsClosed = true;
      if (owned) childTerminal = { code: owned.exitCode, signal: owned.signalCode };
    } catch (error) {
      cleanupError = error;
    } finally {
      clearTimeout(force);
      try {
        if (sentinel) {
          const stoppedSentinel = sentinel;
          await tmux(["kill-server"]);
          await vi.waitFor(
            async () =>
              expect(await readLiveProcessStarttime(stoppedSentinel.pid)).not.toBe(
                stoppedSentinel.starttime,
              ),
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
      startupObservations: observations.flatMap((observation) => observation.phases),
      childExits,
      childGenerations: observations.map((observation) => observation.evidence),
      sourceBefore,
      sourceAfter,
      sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
      cleanup: {
        childPid: owned?.pid,
        childTerminal,
        childExitObserved: childTerminal !== undefined,
        streamsClosed,
        sentinelStopped,
        networkClosed: networkCleanup.every((item) => item.status === "fulfilled"),
        error: cleanupError instanceof Error ? cleanupError.message : null,
      },
    });
    if (streamsClosed && process.env.SPUR_SESSION_ARTIFACTS_DIR)
      await writePrivateEvidence(
        join(process.env.SPUR_SESSION_ARTIFACTS_DIR, "isolated-restart-proof.json"),
        evidence,
      );
    expect(cleanupError).toBeUndefined();
    expect(childTerminal).toBeDefined();
    expect(sentinelStopped).toBe(true);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(networkCleanup.every((item) => item.status === "fulfilled")).toBe(true);
  }
}, 45000);
