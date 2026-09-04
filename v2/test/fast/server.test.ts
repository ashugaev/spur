import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logSpurEvent, readEventLog } from "../../src/event-log.js";
import { _resetGhPathCacheForTests } from "../../src/gh.js";
import { writeSession } from "../../src/metadata.js";
import { sessionArtifactsDir } from "../../src/session-artifacts.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { TodoEmptyLedgerError, TodoOpenWorkError } from "../../src/todo.js";
import {
  OpenPrActionRequiredError,
  QueueDeliveryInFlightError,
  SessionNotReopenableError,
  SessionNotRestorableError,
  SessionRateLimitedError,
  SessionResourceNotFoundError,
  SidecarPortConflictError,
  SessionService,
} from "../../src/session-service.js";
import type { SessionRecord, SessionView } from "../../src/types.js";
import {
  type ConfigRegistryFile,
  readConfigRegistryFile,
  writeConfigRegistryFile,
} from "../../src/registry.js";
import { findFreePort } from "../helpers/common.js";

describe("startServer", () => {
  it("rejects a missing non-default config path without bootstrapping it on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const configPath = join(root, "does-not-exist", "spur.yaml");

    await expect(
      startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      }),
    ).rejects.toThrow("does not exist");

    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("serves runtime info and stops cleanly in-process", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/info`);
      expect(response.status).toBe(200);
      const info = (await response.json()) as { port: number; version?: unknown };
      expect(info).toMatchObject({
        ok: true,
        port,
      });
      expect(typeof info.version).toBe("string");

      const missing = await fetch(`http://127.0.0.1:${port}/missing`);
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }

    // Host memory pressure fires these on a loaded runner and not on an idle
    // box. This test pins the startup/shutdown sequence, not memory behavior.
    const hostMemoryEvents = new Set([
      "daemon.memory.unbounded",
      "daemon.memory.shed",
      "daemon.memory.shed.failed",
    ]);
    const events = readEventLog(dataDir).filter((entry) => !hostMemoryEvents.has(entry.event));
    expect(events[0]).toMatchObject({
      event: "daemon.registry.count",
      details: { read: 1, worktreeInternalDropped: 0 },
    });
    expect(events[1]).toMatchObject({
      event: "gh.poll_cycle",
      details: { cycle: "attention", calls: 0 },
    });
    expect(events.map((entry) => entry.event)).toEqual([
      "daemon.registry.count",
      "gh.poll_cycle",
      "daemon.startup.reconciled",
      "daemon.admission.startup",
      "daemon.started",
      "http.route.not_found",
      "daemon.stopping",
      "daemon.stopped",
    ]);
    expect(events.find((entry) => entry.event === "daemon.admission.startup")).toMatchObject({
      details: { cap: 100, capSource: "default", live: 0 },
    });
    await expect(fetch(`http://127.0.0.1:${port}/info`)).rejects.toThrow();
  });

  it("POST /sidecars/sweep defaults to report-only — reap absent kills nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const defaultResponse = await fetch(`http://127.0.0.1:${port}/sidecars/sweep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(defaultResponse.status).toBe(200);
      const defaultResult = (await defaultResponse.json()) as {
        supported: boolean;
        leaked: unknown[];
        reaped: unknown[];
      };
      expect(defaultResult.reaped).toEqual([]);

      const reapResponse = await fetch(`http://127.0.0.1:${port}/sidecars/sweep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reap: true }),
      });
      expect(reapResponse.status).toBe(200);
      const reapResult = (await reapResponse.json()) as {
        supported: boolean;
        leaked: unknown[];
        reaped: unknown[];
      };
      // Nothing leaked in this empty sandbox, so both calls report the same
      // shape either way — the important assertion is the default omits any
      // reaping regardless of what `leaked` ends up containing.
      expect(reapResult.leaked).toEqual(defaultResult.leaked);
    } finally {
      await server.stop();
    }
  });

  it("reports an unbounded fleet cgroup once during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-memory-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );
    vi.spyOn(SessionService.prototype, "getMemoryCeilingWarning").mockReturnValue({
      cgroupPath: "/system.slice/spur-daemon.service",
      memoryMaxUnlimited: true,
      memoryHighUnlimited: true,
      oomdPresent: false,
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const events = readEventLog(dataDir).filter(
        (entry) => entry.event === "daemon.memory.unbounded",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "warn",
        details: {
          cgroupPath: "/system.slice/spur-daemon.service",
          memoryMaxUnlimited: true,
          oomdPresent: false,
        },
      });
      expect(stderrSpy).toHaveBeenCalledWith(
        "Spur fleet cgroup /system.slice/spur-daemon.service has unlimited memory.max and systemd-oomd is absent\n",
      );
    } finally {
      await server.stop();
      vi.restoreAllMocks();
    }
  });

  it("GET /headroom returns cap, projectCaps, live, projectedRoom, per-session rss, memory, and guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const session: SessionRecord = {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      };
      writeSession(dataDir, session);

      const response = await fetch(`http://127.0.0.1:${port}/headroom`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        cap: { global: number; source: string; perSessionBytes: number; reserveFraction: number };
        projectCaps: Record<string, number>;
        live: { count: number; byProject: Record<string, number> };
        projectedRoom: number;
        sessions: Array<{ id: string; project: string; status: string; rssBytes: number }>;
        memory: unknown;
        guard: {
          enforce: boolean;
          minAvailableBytes: number;
          minFreeSwapBytes: number;
          crossed: boolean;
        };
      };
      expect(body.cap).toMatchObject({ global: 100, source: "default" });
      expect(body.live).toEqual({ count: 1, byProject: { demo: 1 } });
      expect(body.projectedRoom).toBe(body.cap.global - 1);
      expect(body.sessions).toEqual([
        { id: "demo-1", project: "demo", status: "running", rssBytes: expect.any(Number) },
      ]);
      expect(typeof body.guard.enforce).toBe("boolean");
      expect(typeof body.guard.crossed).toBe("boolean");
      expect(body.memory === null || typeof body.memory === "object").toBe(true);
      expect(body.projectCaps).toEqual({});
    } finally {
      await server.stop();
    }
  });

  it("returns 429 naming the cap and live count when spawn is denied by the admission cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const { SessionAdmissionDeniedError } = await import("../../src/session-service.js");
    const originalSpawn = SessionService.prototype.spawn;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      SessionService.prototype.spawn = async function mockSpawn() {
        throw new SessionAdmissionDeniedError(
          'Cannot spawn session for project "demo": at the global cap of 2 live sessions (2 live now). Stop one of: demo-1 (demo).',
        );
      };

      server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });

      const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "demo", prompt: "hello" }),
      });
      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("2");
      expect(body.error).toContain("cap");
    } finally {
      SessionService.prototype.spawn = originalSpawn;
      await server?.stop();
    }
  });

  it("flushes a pending collapsed warn before the final daemon.stopped log", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      // All three fall inside the default 60s collapse window: the first
      // writes immediately, the next two are suppressed (suppressedCount 2).
      logSpurEvent(dataDir, {
        event: "session.wake.interval_failed",
        level: "warn",
        message: "first",
      });
      logSpurEvent(dataDir, {
        event: "session.wake.interval_failed",
        level: "warn",
        message: "second",
      });
      logSpurEvent(dataDir, {
        event: "session.wake.interval_failed",
        level: "warn",
        message: "third",
      });
    } finally {
      await server.stop();
    }

    const events = readEventLog(dataDir);
    const summaryIndex = events.findIndex((entry) => entry.details?.["suppressedCount"] === 2);
    const stoppedIndex = events.findIndex((entry) => entry.event === "daemon.stopped");
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(summaryIndex);
  });

  it("force closes active requests during stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalList = SessionService.prototype.list;
    let markListCalled: () => void = () => undefined;
    const listCalled = new Promise<void>((resolve) => {
      markListCalled = resolve;
    });
    SessionService.prototype.list = async function mockList() {
      markListCalled();
      return await new Promise<SessionView[]>(() => undefined);
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    let stopped = false;
    try {
      const requestResult = fetch(`http://127.0.0.1:${port}/sessions`).catch(
        (error: unknown) => error,
      );
      await listCalled;

      const startedAt = Date.now();
      await server.stop();
      stopped = true;
      expect(Date.now() - startedAt).toBeLessThan(6_500);

      const result = await requestResult;
      expect(result).toBeInstanceOf(Error);
    } finally {
      SessionService.prototype.list = originalList;
      if (!stopped) {
        await server.stop();
      }
    }
  }, 8_000);

  it("runs shutdown teardown once for concurrent stop() calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    await Promise.all([server.stop(), server.stop(), server.stop()]);

    const stoppedEvents = readEventLog(dataDir).filter((entry) => entry.event === "daemon.stopped");
    expect(stoppedEvents).toHaveLength(1);
  });

  it("completes shutdown and warns when the background-spawn drain never settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    // The drain hangs forever; the withTimeout(5s) bound in shutdown() must trip and
    // let shutdown finish. Fake timers fire that 5s bound without a real wait while the
    // HTTP close path (real I/O, unaffected by fake timers) still resolves on `await`.
    vi.spyOn(server, "settleBackgroundSpawns").mockReturnValue(new Promise<void>(() => undefined));
    vi.useFakeTimers();
    try {
      const stopped = server.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }

    const events = readEventLog(dataDir).map((entry) => entry.event);
    expect(events).toContain("daemon.shutdown.spawn_drain_timeout");
    // Drain failure must not abort shutdown: daemon.stopped still fires afterwards.
    expect(events.indexOf("daemon.stopped")).toBeGreaterThan(
      events.indexOf("daemon.shutdown.spawn_drain_timeout"),
    );
  });

  it("keeps the SIGTERM listener registered via process.on (not process.once), so a repeat signal during shutdown re-enters instead of terminating the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const beforeStartCount = process.listenerCount("SIGTERM");
    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });
    const afterStartCount = process.listenerCount("SIGTERM");
    expect(afterStartCount).toBe(beforeStartCount + 1);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      process.emit("SIGTERM");
      // `process.once` would already have deregistered the listener synchronously as
      // part of `emit`, before the async shutdown body even runs its first await. A
      // repeat SIGTERM arriving during the shutdown grace window must still be caught.
      expect(process.listenerCount("SIGTERM")).toBe(afterStartCount);

      await server.stop();
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
    expect(process.listenerCount("SIGTERM")).toBe(beforeStartCount);
  });

  it("starts with a clear warning when gh is missing from PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const emptyBinDir = join(root, "empty-bin");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    await mkdir(emptyBinDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const savedPath = process.env.PATH;
    const warnings: string[] = [];
    process.env.PATH = emptyBinDir;
    _resetGhPathCacheForTests();
    const server = await startServer(configPath, {
      info: () => undefined,
      warn: (message) => warnings.push(message),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/info`);
      expect(response.status).toBe(200);
      expect(warnings).toContain(
        "gh not found on PATH; GitHub automation disabled until gh is available",
      );
    } finally {
      process.env.PATH = savedPath;
      _resetGhPathCacheForTests();
      await server.stop();
    }
  });

  it("includes completed sessions only when GET /sessions opts in", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalList = SessionService.prototype.list;
    const calls: Array<{ includeCompleted?: boolean; view?: "full" | "dashboard" }> = [];
    SessionService.prototype.list = async function mockList(options = {}) {
      calls.push(options);
      return [
        {
          id: "demo-done",
          project: "demo",
          agent: "claude",
          prompt: "ship it",
          branch: "demo-done",
          worktree: true,
          worktreePath: join(worktreeDir, "demo", "demo-done"),
          tmuxSession: "demo-done",
          launchCommand: "",
          status: "completed",
          state: "stopped",
          runtimeAlive: false,
          workspaceExists: false,
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
          lastActivityAt: "2026-04-15T00:00:00.000Z",
          artifacts: [],
          services: [],
          sidecars: [],
        },
      ];
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const defaultResponse = await fetch(`http://127.0.0.1:${port}/sessions`);
      expect(defaultResponse.status).toBe(200);
      await expect(defaultResponse.json()).resolves.toMatchObject([{ id: "demo-done" }]);

      const completedResponse = await fetch(`http://127.0.0.1:${port}/sessions?includeCompleted=1`);
      expect(completedResponse.status).toBe(200);
      await expect(completedResponse.json()).resolves.toMatchObject([
        { id: "demo-done", status: "completed" },
      ]);

      const dashboardResponse = await fetch(`http://127.0.0.1:${port}/sessions?view=dashboard`);
      expect(dashboardResponse.status).toBe(200);
      await expect(dashboardResponse.json()).resolves.toMatchObject([{ id: "demo-done" }]);
    } finally {
      SessionService.prototype.list = originalList;
      await server.stop();
    }

    expect(calls).toEqual([
      { includeCompleted: false, view: "full" },
      { includeCompleted: true, view: "full" },
      { includeCompleted: false, view: "dashboard" },
    ]);
  });

  it("serves compact JSON with a content-length instead of a pretty-printed body", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/info`);
      const body = await response.text();

      expect(response.status).toBe(200);
      // The listing payloads run to megabytes; the 2-space indent was ~10% of
      // every one of them, re-serialized on each poll.
      expect(body).not.toMatch(/\n\s+"/);
      expect(JSON.parse(body)).toMatchObject({ version: expect.any(String) });
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    } finally {
      await server.stop();
    }
  });

  it("forwards clearPort to sidecar start", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalStartSidecar = SessionService.prototype.startSidecar;
    let clearPort: number | undefined;
    SessionService.prototype.startSidecar = async function mockStartSidecar(
      _sessionId,
      _sidecarName,
      request,
    ) {
      clearPort = request?.clearPort;
      return {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "",
        status: "running",
        state: "waiting",
        runtimeAlive: true,
        workspaceExists: true,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        lastActivityAt: "2026-04-15T00:00:00.000Z",
        artifacts: [],
        services: [],
        sidecars: [{ name: "dev", alive: true, ports: [], tmuxSession: "demo-1--dev" }],
      } satisfies SessionView;
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/sidecars/dev/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clearPort: 3000 }),
      });
      expect(response.status).toBe(200);
      expect(clearPort).toBe(3000);
    } finally {
      SessionService.prototype.startSidecar = originalStartSidecar;
      await server.stop();
    }
  });

  it("returns structured conflict JSON for busy sidecar ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalStartSidecar = SessionService.prototype.startSidecar;
    SessionService.prototype.startSidecar = async function mockStartSidecar() {
      throw new SidecarPortConflictError("dev", [
        {
          portId: "http",
          env: "SPUR_RESERVED_PORT_DEV",
          port: 3000,
        },
      ]);
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/sidecars/dev/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "sidecar_port_busy",
        sidecarName: "dev",
        candidates: [
          {
            portId: "http",
            env: "SPUR_RESERVED_PORT_DEV",
            port: 3000,
          },
        ],
      });
    } finally {
      SessionService.prototype.startSidecar = originalStartSidecar;
      await server.stop();
    }
  });

  it("returns the Shepherd session alone unless reportDisposition is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalSpawnShepherd = SessionService.prototype.spawnShepherd;
    const prompts: Array<string | undefined> = [];
    SessionService.prototype.spawnShepherd = async function mockSpawnShepherd(request = {}) {
      prompts.push(request.prompt);
      return {
        disposition: "reused" as const,
        session: { id: "shp-1", project: "spur-shepherd" } as never,
      };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const legacy = await fetch(`http://127.0.0.1:${port}/shepherd/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "check health" }),
      });
      expect(legacy.status).toBe(201);
      await expect(legacy.json()).resolves.toEqual({ id: "shp-1", project: "spur-shepherd" });

      const reported = await fetch(`http://127.0.0.1:${port}/shepherd/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "diagnose", reportDisposition: true }),
      });
      expect(reported.status).toBe(201);
      await expect(reported.json()).resolves.toEqual({
        disposition: "reused",
        session: { id: "shp-1", project: "spur-shepherd" },
      });
      expect(prompts).toEqual(["check health", "diagnose"]);
    } finally {
      SessionService.prototype.spawnShepherd = originalSpawnShepherd;
      await server.stop();
    }
  });

  it("returns structured conflict JSON when complete needs a pull request action", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalComplete = SessionService.prototype.complete;
    const requests: unknown[] = [];
    SessionService.prototype.complete = async function mockComplete(_sessionId, request) {
      requests.push(request);
      throw new OpenPrActionRequiredError("demo-1", {
        number: 42,
        title: "Fix checkout",
        url: "https://github.com/acme/api/pull/42",
      });
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "open_pr_action_required",
        sessionId: "demo-1",
        pr: {
          number: 42,
          title: "Fix checkout",
          url: "https://github.com/acme/api/pull/42",
        },
      });

      const retry = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prAction: "leave_open" }),
      });
      expect(retry.status).toBe(409);
      expect(requests).toEqual([{}, { prAction: "leave_open" }]);
    } finally {
      SessionService.prototype.complete = originalComplete;
      await server.stop();
    }
  });

  it("returns structured conflict JSON when restore is not possible", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalRestore = SessionService.prototype.restore;
    SessionService.prototype.restore = async function mockRestore(_sessionId) {
      throw new SessionNotRestorableError("demo-1", "Session demo-1 is not restorable", [
        "force_kill",
        "respawn",
      ]);
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/restore`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "session_not_restorable",
        sessionId: "demo-1",
        reason: "Session demo-1 is not restorable",
        availableActions: ["force_kill", "respawn"],
      });
    } finally {
      SessionService.prototype.restore = originalRestore;
      await server.stop();
    }
  });

  it("routes POST /sessions/:id/reopen and forwards a refusal as 409", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalReopen = SessionService.prototype.reopen;
    const calls: string[] = [];
    SessionService.prototype.reopen = async function mockReopen(sessionId) {
      calls.push(sessionId);
      if (sessionId === "demo-1") {
        throw new SessionNotReopenableError(
          "Session demo-1 is running, not completed — use restore or respawn",
        );
      }
      return { id: sessionId, status: "running" } as SessionView;
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const refused = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/reopen`, {
        method: "POST",
      });
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toEqual({
        error: "Session demo-1 is running, not completed — use restore or respawn",
      });

      const accepted = await fetch(`http://127.0.0.1:${port}/sessions/demo-2/reopen`, {
        method: "POST",
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ id: "demo-2", status: "running" });
      expect(calls).toEqual(["demo-1", "demo-2"]);
    } finally {
      SessionService.prototype.reopen = originalReopen;
      await server.stop();
    }
  });

  it("returns 409 when sending to a rate-limited session with queue: false", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalSend = SessionService.prototype.send;
    SessionService.prototype.send = async function mockSend(_sessionId, _body) {
      throw new SessionRateLimitedError("Session demo-1 is rate limited");
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", queue: false }),
      });
      expect(response.status).toBe(409);
    } finally {
      SessionService.prototype.send = originalSend;
      await server.stop();
    }
  });

  it("maps queue remove/flush 404 (not queued) and 409 (delivery in flight), and 400 on an empty message", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalRemove = SessionService.prototype.removeQueuedMessage;
    const originalFlush = SessionService.prototype.flushQueuedMessage;
    SessionService.prototype.removeQueuedMessage = async function mockRemove(sessionId, message) {
      if (message === "not queued") {
        throw new SessionResourceNotFoundError(`Message not found in queue for ${sessionId}`);
      }
      throw new Error(`unexpected message: ${message}`);
    };
    SessionService.prototype.flushQueuedMessage = async function mockFlush(_sessionId, message) {
      if (message === "in flight") {
        throw new QueueDeliveryInFlightError("Delivery already in flight for demo-1");
      }
      throw new Error(`unexpected message: ${message}`);
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const notFound = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "not queued" }),
      });
      expect(notFound.status).toBe(404);

      const inFlight = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "in flight" }),
      });
      expect(inFlight.status).toBe(409);

      const emptyMessage = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });
      expect(emptyMessage.status).toBe(400);

      const missingMessage = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingMessage.status).toBe(400);
    } finally {
      SessionService.prototype.removeQueuedMessage = originalRemove;
      SessionService.prototype.flushQueuedMessage = originalFlush;
      await server.stop();
    }
  });

  it("forwards a trimmed message to queue remove/flush, so validation and lookup agree on normalization (PR #708 comment 3)", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalRemove = SessionService.prototype.removeQueuedMessage;
    const originalFlush = SessionService.prototype.flushQueuedMessage;
    const receivedRemove: string[] = [];
    const receivedFlush: string[] = [];
    SessionService.prototype.removeQueuedMessage = async function mockRemove(_sessionId, message) {
      receivedRemove.push(message);
      return { id: "demo-1" } as unknown as SessionView;
    };
    SessionService.prototype.flushQueuedMessage = async function mockFlush(_sessionId, message) {
      receivedFlush.push(message);
      return { id: "demo-1" } as unknown as SessionView;
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const remove = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  padded text  " }),
      });
      expect(remove.status).toBe(200);
      expect(receivedRemove).toEqual(["padded text"]);

      const flush = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "\tanother\n" }),
      });
      expect(flush.status).toBe(200);
      expect(receivedFlush).toEqual(["another"]);

      // Whitespace-only still counts as empty after trimming.
      const whitespaceOnly = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/queue/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      });
      expect(whitespaceOnly.status).toBe(400);
    } finally {
      SessionService.prototype.removeQueuedMessage = originalRemove;
      SessionService.prototype.flushQueuedMessage = originalFlush;
      await server.stop();
    }
  });

  it("routes POST /sessions/background to background spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const spawnInBackground = SessionService.prototype.spawnInBackground;
    SessionService.prototype.spawnInBackground = async function mockSpawnInBackground() {
      return {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "",
        status: "spawning",
        state: "working",
        runtimeAlive: false,
        workspaceExists: false,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        lastActivityAt: "2026-04-15T00:00:00.000Z",
        artifacts: [],
        services: [],
        sidecars: [],
      };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/background`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "demo", prompt: "ship it" }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        id: "demo-1",
        status: "spawning",
      });
    } finally {
      SessionService.prototype.spawnInBackground = spawnInBackground;
      await server.stop();
    }
  });

  it("routes backlog list through the session service", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const listAvailableBacklog = SessionService.prototype.listAvailableBacklog;
    SessionService.prototype.listAvailableBacklog = function mockListAvailableBacklog() {
      return [
        {
          provider: "jira",
          projectId: "demo",
          backlogId: "features",
          externalId: "10001",
          key: "WEB-17",
          title: "Fix checkout",
          url: "https://jira.example.com/browse/WEB-17",
          fetchedAt: "2026-06-16T12:00:00.000Z",
          position: 0,
        },
      ];
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const availableResponse = await fetch(`http://127.0.0.1:${port}/backlog/available`);
      expect(availableResponse.status).toBe(200);
      await expect(availableResponse.json()).resolves.toMatchObject([{ key: "WEB-17" }]);
    } finally {
      SessionService.prototype.listAvailableBacklog = listAvailableBacklog;
      await server.stop();
    }
  });

  it("routes recurring wake scheduling and cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const scheduleWake = SessionService.prototype.scheduleWake;
    const cancelWake = SessionService.prototype.cancelWake;
    const scheduleRequests: unknown[] = [];
    SessionService.prototype.scheduleWake = async function mockScheduleWake(_sessionId, request) {
      scheduleRequests.push(request);
      return {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "",
        status: "running",
        state: "waiting",
        runtimeAlive: true,
        workspaceExists: true,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        lastActivityAt: "2026-04-15T00:00:00.000Z",
        intervalWake: {
          nextDueAt: "2026-04-15T00:10:00.000Z",
          intervalMs: 600_000,
          message: "Check CI",
          stopCondition: "CI is green",
        },
        dailyWake: {
          dailyAt: ["09:30"],
          nextDueAt: "2026-04-15T09:30:00.000Z",
          message: "Check morning state",
          stopCondition: "Morning check done",
        },
        artifacts: [],
        services: [],
        sidecars: [],
      };
    };
    SessionService.prototype.cancelWake = async function mockCancelWake() {
      return {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "",
        status: "running",
        state: "waiting",
        runtimeAlive: true,
        workspaceExists: true,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        lastActivityAt: "2026-04-15T00:00:00.000Z",
        artifacts: [],
        services: [],
        sidecars: [],
      };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const scheduleResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intervalMs: 600_000,
          stopCondition: "CI is green",
          message: "Check CI",
        }),
      });
      expect(scheduleResponse.status).toBe(200);
      await expect(scheduleResponse.json()).resolves.toMatchObject({
        id: "demo-1",
        intervalWake: {
          intervalMs: 600_000,
          stopCondition: "CI is green",
        },
      });
      expect(scheduleRequests).toEqual([
        {
          intervalMs: 600_000,
          stopCondition: "CI is green",
          message: "Check CI",
        },
      ]);

      const dailyResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dailyAt: ["09:30"],
          stopCondition: "Morning check done",
          message: "Check morning state",
        }),
      });
      expect(dailyResponse.status).toBe(200);
      await expect(dailyResponse.json()).resolves.toMatchObject({
        id: "demo-1",
        dailyWake: {
          dailyAt: ["09:30"],
          stopCondition: "Morning check done",
        },
      });
      expect(scheduleRequests.at(-1)).toEqual({
        dailyAt: ["09:30"],
        stopCondition: "Morning check done",
        message: "Check morning state",
      });

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/wake/cancel`, {
        method: "POST",
      });
      expect(cancelResponse.status).toBe(200);
      await expect(cancelResponse.json()).resolves.not.toHaveProperty("intervalWake");
    } finally {
      SessionService.prototype.scheduleWake = scheduleWake;
      SessionService.prototype.cancelWake = cancelWake;
      await server.stop();
    }
  });

  it("routes POST /sessions/:id/complete by default, desk scope, and invalid scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const view: SessionView = {
      id: "demo-1",
      project: "demo",
      agent: "claude",
      prompt: "ship it",
      branch: "demo-1",
      worktree: true,
      worktreePath: join(worktreeDir, "demo", "demo-1"),
      tmuxSession: "demo-1",
      launchCommand: "",
      status: "completed",
      state: "stopped",
      runtimeAlive: false,
      workspaceExists: false,
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
      lastActivityAt: "2026-04-15T00:00:00.000Z",
      artifacts: [],
      services: [],
      sidecars: [],
    };
    const originalComplete = SessionService.prototype.complete;
    const originalCompleteDesk = SessionService.prototype.completeDesk;
    const calls: string[] = [];
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      calls.push(`session:${sessionId}`);
      return view;
    };
    SessionService.prototype.completeDesk = async function mockCompleteDesk(sessionId: string) {
      calls.push(`desk:${sessionId}`);
      return {
        completedIds: [sessionId],
      };
    };

    const completeServer = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const defaultResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
      });
      expect(defaultResponse.status).toBe(200);
      await expect(defaultResponse.json()).resolves.toMatchObject({ id: "demo-1" });

      const deskResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "desk" }),
      });
      expect(deskResponse.status).toBe(200);
      await expect(deskResponse.json()).resolves.toMatchObject({
        completedIds: ["demo-1"],
      });

      const invalidResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "project" }),
      });
      expect(invalidResponse.status).toBe(400);
    } finally {
      SessionService.prototype.complete = originalComplete;
      SessionService.prototype.completeDesk = originalCompleteDesk;
      await completeServer.stop();
    }

    expect(calls).toEqual(["session:demo-1", "desk:demo-1"]);
  });

  it("returns 409 todo_ledger_empty naming the fix when completing an empty ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalComplete = SessionService.prototype.complete;
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      throw new TodoEmptyLedgerError([sessionId]);
    };

    let server: StartedServer | undefined;
    try {
      server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });

      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        code: string;
        sessionId: string;
        error: string;
      };
      expect(body.code).toBe("todo_ledger_empty");
      expect(body.sessionId).toBe("demo-1");
      expect(body.error).toContain("$SPUR_TODO_COMMAND");
      expect(body.error).toContain("add");
    } finally {
      SessionService.prototype.complete = originalComplete;
      await server?.stop();
    }
  });

  it("returns 409 todo_open_work with an actionable error alongside the sessions array", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalComplete = SessionService.prototype.complete;
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      throw new TodoOpenWorkError([{ sessionId, openItemIds: ["item-1"], heldItemIds: [] }]);
    };

    let server: StartedServer | undefined;
    try {
      server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });

      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        code: string;
        sessions: Array<{ sessionId: string; openItemIds: string[]; heldItemIds: string[] }>;
        error: string;
      };
      expect(body.code).toBe("todo_open_work");
      expect(body.sessions).toEqual([
        { sessionId: "demo-1", openItemIds: ["item-1"], heldItemIds: [] },
      ]);
      expect(body.error).toContain("$SPUR_TODO_COMMAND");
    } finally {
      SessionService.prototype.complete = originalComplete;
      await server?.stop();
    }
  });

  it("streams session artifact content through GET /sessions/:id/artifacts/:artifactId", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    const artifactPath = join(root, "shot.png");
    await writeFile(artifactPath, "artifact-bytes", "utf8");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const getArtifact = SessionService.prototype.getArtifact;
    SessionService.prototype.getArtifact = function mockGetArtifact() {
      return {
        id: "shot.png",
        name: "shot.png",
        size: 14,
        mimeType: "image/png",
        kind: "image",
        origin: "intentional",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        path: artifactPath,
      };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/artifacts/shot.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toContain("inline");
      expect(response.headers.get("content-security-policy")).toBeNull();
      await expect(response.text()).resolves.toBe("artifact-bytes");
    } finally {
      SessionService.prototype.getArtifact = getArtifact;
      await server.stop();
    }
  });

  it("streams a nested artifact through GET /sessions/:id/artifacts/:path", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const session: SessionRecord = {
      id: "demo-nested",
      project: "demo",
      agent: "claude",
      prompt: "ship it",
      branch: "demo-nested",
      worktree: true,
      worktreePath: join(worktreeDir, "demo", "demo-nested"),
      tmuxSession: "demo-nested",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    };
    writeSession(dataDir, session);
    const artifactsDir = sessionArtifactsDir(dataDir, session.id);
    await mkdir(join(artifactsDir, "design"), { recursive: true });
    await writeFile(join(artifactsDir, "design", "design-spec.md"), "# Spec", "utf8");

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-nested/artifacts/design/design-spec.md`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain('filename="design-spec.md"');
      await expect(response.text()).resolves.toBe("# Spec");
    } finally {
      await server.stop();
    }
  });

  it("answers 404 for an artifact id that escapes the artifacts root", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const session: SessionRecord = {
      id: "demo-escape",
      project: "demo",
      agent: "claude",
      prompt: "ship it",
      branch: "demo-escape",
      worktree: true,
      worktreePath: join(worktreeDir, "demo", "demo-escape"),
      tmuxSession: "demo-escape",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    };
    writeSession(dataDir, session);
    await mkdir(sessionArtifactsDir(dataDir, session.id), { recursive: true });

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      // A ".." segment bounded by a real "/" is dot-segment-normalized by the client's own
      // URL parser before the request leaves — even when the dots themselves are percent-
      // encoded (WHATWG URL normalization decodes a segment to check for "." and ".." before
      // it decides whether to remove it). Encoding the SLASH instead keeps the whole tail one
      // opaque segment through the client parser; the daemon route captures it whole and only
      // decodes once it owns the string, so the traversal survives to parseArtifactRelativePath.
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-escape/artifacts/..%2F..%2Fetc%2Fpasswd`,
      );
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("Artifact not found:");
    } finally {
      await server.stop();
    }
  });

  it("answers 404 for a symlink that resolves outside the artifacts root", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const session: SessionRecord = {
      id: "demo-symlink-escape",
      project: "demo",
      agent: "claude",
      prompt: "ship it",
      branch: "demo-symlink-escape",
      worktree: true,
      worktreePath: join(worktreeDir, "demo", "demo-symlink-escape"),
      tmuxSession: "demo-symlink-escape",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    };
    writeSession(dataDir, session);
    const artifactsDir = sessionArtifactsDir(dataDir, session.id);
    await mkdir(artifactsDir, { recursive: true });
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "top secret", "utf8");
    await symlink(join(outsideDir, "secret.txt"), join(artifactsDir, "evil"), "file");

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-symlink-escape/artifacts/evil`,
      );
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("Artifact not found:");
    } finally {
      await server.stop();
    }
  });

  it("answers 404, not 500, for an artifact id with an invalid percent-encoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const session: SessionRecord = {
      id: "demo-bad-encoding",
      project: "demo",
      agent: "claude",
      prompt: "ship it",
      branch: "demo-bad-encoding",
      worktree: true,
      worktreePath: join(worktreeDir, "demo", "demo-bad-encoding"),
      tmuxSession: "demo-bad-encoding",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    };
    writeSession(dataDir, session);
    await mkdir(sessionArtifactsDir(dataDir, session.id), { recursive: true });

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      // "%E0%A4%A" is a truncated UTF-8 sequence: decodeURIComponent throws a URIError on
      // it. That's an artifact id nothing can ever match, so it must answer 404 like any
      // other unknown id — never the generic 500 an uncaught URIError falls through to.
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-bad-encoding/artifacts/%E0%A4%A`,
      );
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("Artifact not found:");
    } finally {
      await server.stop();
    }
  });

  it("keeps the html artifact sandbox identical to the web preview frames", async () => {
    // The web package cannot import from v2, so the flag list exists twice. Drift
    // between the CSP header and the iframe sandbox must fail here, not in a browser.
    const flagPattern = /ARTIFACT_HTML_SANDBOX = "([^"]+)"/;
    const daemonSource = await readFile(new URL("../../src/server.ts", import.meta.url), "utf8");
    const webSource = await readFile(
      new URL("../../../packages/web/src/lib/artifact-html.ts", import.meta.url),
      "utf8",
    );

    const daemonPolicy = daemonSource.match(flagPattern)?.[1];
    const webFlags = webSource.match(flagPattern)?.[1];

    expect(webFlags).toBeTruthy();
    expect(daemonPolicy).toBe(`sandbox ${webFlags}`);
    expect(daemonPolicy).not.toContain("allow-same-origin");
  });

  it("hands SVG artifacts over as downloads so they never render on Spur's origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    const artifactPath = join(root, "chart.svg");
    await writeFile(artifactPath, "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const getArtifact = SessionService.prototype.getArtifact;
    SessionService.prototype.getArtifact = function mockGetArtifact() {
      return {
        id: "chart.svg",
        name: "chart.svg",
        size: 38,
        mimeType: "image/svg+xml",
        kind: "image",
        origin: "intentional",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        path: artifactPath,
      };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/artifacts/chart.svg`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      expect(response.headers.get("content-disposition")).toContain("attachment");
      await response.text();
    } finally {
      SessionService.prototype.getArtifact = getArtifact;
      await server.stop();
    }
  });

  it("sandboxes HTML artifacts served through GET /sessions/:id/artifacts/:artifactId", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    const artifactPath = join(root, "report.html");
    await writeFile(artifactPath, "<h1>Report</h1>", "utf8");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const getArtifact = SessionService.prototype.getArtifact;
    SessionService.prototype.getArtifact = function mockGetArtifact() {
      return {
        id: "report.html",
        name: "report.html",
        size: 15,
        mimeType: "text/html; charset=utf-8",
        kind: "text",
        origin: "intentional",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        path: artifactPath,
      };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/artifacts/report.html`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain("inline");
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-forms allow-popups allow-modals",
      );
      await expect(response.text()).resolves.toBe("<h1>Report</h1>");
    } finally {
      SessionService.prototype.getArtifact = getArtifact;
      await server.stop();
    }
  });

  it("returns 404 for GET /sessions/:id and /sessions/:id/conversation when the session is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions/does-not-exist`);
      expect(sessionResponse.status).toBe(404);
      await expect(sessionResponse.text()).resolves.toContain("Session not found");

      const conversationResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/does-not-exist/conversation`,
      );
      expect(conversationResponse.status).toBe(404);
      await expect(conversationResponse.text()).resolves.toContain("Session not found");
    } finally {
      await server.stop();
    }
  });

  it("routes POST /sessions/:id/self-destruct and returns the completed session", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalSelfDestruct = SessionService.prototype.selfDestruct;
    SessionService.prototype.selfDestruct = async function mockSelfDestruct(sessionId: string) {
      return {
        id: sessionId,
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", sessionId),
        tmuxSession: sessionId,
        launchCommand: "",
        status: "completed",
        state: "stopped",
        runtimeAlive: false,
        workspaceExists: false,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        lastActivityAt: "2026-04-15T00:00:00.000Z",
        artifacts: [],
        services: [],
        sidecars: [],
      } satisfies SessionView;
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const completed = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/self-destruct`, {
        method: "POST",
      });
      expect(completed.status).toBe(200);
      await expect(completed.json()).resolves.toMatchObject({
        id: "demo-1",
        status: "completed",
      });
    } finally {
      SessionService.prototype.selfDestruct = originalSelfDestruct;
      await server.stop();
    }
  });

  it("serves session memory routes with validation and missing-key errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const session: SessionRecord = {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      };
      writeSession(dataDir, session);

      const setResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/session-memory/decision.api`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Use HTTP API", tags: ["API"] }),
        },
      );
      expect(setResponse.status).toBe(200);
      await expect(setResponse.json()).resolves.toMatchObject({
        record: {
          key: "decision.api",
          kind: "note",
          body: "Use HTTP API",
          status: "active",
          tags: ["api"],
        },
      });

      const listResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/session-memory`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        records: [{ key: "decision.api" }],
      });

      const getResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/session-memory/decision.api`,
      );
      expect(getResponse.status).toBe(200);
      await expect(getResponse.json()).resolves.toMatchObject({
        record: { key: "decision.api", status: "active" },
      });

      const resolveResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/session-memory/decision.api/resolve`,
        { method: "POST" },
      );
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toMatchObject({
        record: { key: "decision.api", status: "resolved" },
      });

      const missingKeyResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/session-memory/missing`,
      );
      expect(missingKeyResponse.status).toBe(404);

      const missingSessionResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/missing/session-memory`,
      );
      expect(missingSessionResponse.status).toBe(404);

      const invalidKeyResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/session-memory/Bad`,
      );
      expect(invalidKeyResponse.status).toBe(400);

      const invalidSessionResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/bad%2Fid/session-memory`,
      );
      expect(invalidSessionResponse.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("serves shared memory routes with validation and missing-key errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const session: SessionRecord = {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      };
      writeSession(dataDir, session);

      const setResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project/decision.api`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Use HTTP API" }),
        },
      );
      expect(setResponse.status).toBe(200);
      await expect(setResponse.json()).resolves.toEqual({
        scope: "project",
        entry: { key: "decision.api", body: "Use HTTP API" },
      });

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project`,
      );
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        scope: "project",
        keys: ["decision.api"],
      });

      const getResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project/decision.api`,
      );
      expect(getResponse.status).toBe(200);
      await expect(getResponse.json()).resolves.toEqual({
        scope: "project",
        entry: { key: "decision.api", body: "Use HTTP API" },
      });

      const removeResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project/decision.api`,
        { method: "DELETE" },
      );
      expect(removeResponse.status).toBe(200);
      await expect(removeResponse.json()).resolves.toEqual({
        scope: "project",
        key: "decision.api",
      });

      const missingKeyResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project/decision.api`,
      );
      expect(missingKeyResponse.status).toBe(404);

      const missingKeyRemoveResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project/decision.api`,
        { method: "DELETE" },
      );
      expect(missingKeyRemoveResponse.status).toBe(404);

      const missingSessionResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/missing/shared-memory/project`,
      );
      expect(missingSessionResponse.status).toBe(404);

      const invalidScopeResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/bogus`,
      );
      expect(invalidScopeResponse.status).toBe(400);

      const invalidKeyResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/shared-memory/project/Bad`,
      );
      expect(invalidKeyResponse.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("POST /claude-accounts/remove returns 409 when a running session is bound to the account", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const session: SessionRecord = {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "ship it",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        claudeAccountId: "acc-1",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      };
      writeSession(dataDir, session);

      const response = await fetch(`http://127.0.0.1:${port}/claude-accounts/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "acc-1" }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("in use by 1 running session"),
      });
    } finally {
      await server.stop();
    }
  });

  it("POST /claude-accounts/add returns a summary account without the absolute configDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    // Stub the login pane so the route mapping is tested without spawning tmux.
    const startLoginSpy = vi
      .spyOn(SessionService.prototype, "startAccountLogin")
      .mockResolvedValue({ loginTmuxSession: "claude-login-test" });
    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/claude-accounts/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "work" }),
      });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        account: Record<string, unknown>;
        loginTmuxSession: string;
      };
      expect(payload.loginTmuxSession).toBe("claude-login-test");
      expect(payload.account).toMatchObject({ label: "work", authenticated: false });
      expect(payload.account.id).toEqual(expect.any(String));
      expect(payload.account).not.toHaveProperty("configDir");
    } finally {
      startLoginSpy.mockRestore();
      await server.stop();
    }
  });

  it("serves state subscription routes with validation errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const subscriber: SessionRecord = {
        id: "demo-1",
        project: "demo",
        agent: "claude",
        prompt: "subscriber",
        branch: "demo-1",
        worktree: true,
        worktreePath: join(worktreeDir, "demo", "demo-1"),
        tmuxSession: "demo-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      };
      const target: SessionRecord = {
        ...subscriber,
        id: "demo-2",
        prompt: "target",
        branch: "demo-2",
        worktreePath: join(worktreeDir, "demo", "demo-2"),
        tmuxSession: "demo-2",
      };
      writeSession(dataDir, subscriber);
      writeSession(dataDir, target);

      const createResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetSessionId: "demo-2",
          states: ["error", "needs_input"],
          message: "Check target",
        }),
      });
      expect(createResponse.status).toBe(200);
      await expect(createResponse.json()).resolves.toMatchObject({
        record: {
          id: "state-demo-2",
          targetSessionId: "demo-2",
          states: ["needs_input", "error"],
          message: "Check target",
        },
      });

      const listResponse = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/subscriptions`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        records: [{ id: "state-demo-2" }],
      });

      const invalidStateResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/subscriptions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetSessionId: "demo-2", states: ["blocked"] }),
        },
      );
      expect(invalidStateResponse.status).toBe(400);

      const malformedResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/subscriptions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([]),
        },
      );
      expect(malformedResponse.status).toBe(400);

      const removeResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/subscriptions/state-demo-2/remove`,
        { method: "POST" },
      );
      expect(removeResponse.status).toBe(200);
      await expect(removeResponse.json()).resolves.toEqual({ records: [] });
    } finally {
      await server.stop();
    }
  });

  it("rejects an invalid spawn-time subscriptions payload without spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const spawnSpy = vi.spyOn(SessionService.prototype, "spawn");
    const spawnInBackgroundSpy = vi.spyOn(SessionService.prototype, "spawnInBackground");
    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const invalidStateResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "demo",
          prompt: "hi",
          subscriptions: [{ targetSessionId: "demo-2", states: ["blocked"] }],
        }),
      });
      expect(invalidStateResponse.status).toBe(400);

      const invalidShapeResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "demo", prompt: "hi", subscriptions: {} }),
      });
      expect(invalidShapeResponse.status).toBe(400);

      const backgroundInvalidResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/background`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "demo",
            prompt: "hi",
            subscriptions: [{ targetSessionId: "demo-2", states: ["blocked"] }],
          }),
        },
      );
      expect(backgroundInvalidResponse.status).toBe(400);

      const duplicateTargetResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "demo",
          prompt: "hi",
          subscriptions: [
            { targetSessionId: "demo-2", states: ["waiting"] },
            { targetSessionId: "demo-2", states: ["stopped"] },
          ],
        }),
      });
      expect(duplicateTargetResponse.status).toBe(400);
      const duplicateTargetBody = (await duplicateTargetResponse.json()) as { error?: string };
      expect(duplicateTargetBody.error).toMatch(/must not repeat targetSessionId/);

      const tooManyResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: "demo",
          prompt: "hi",
          subscriptions: Array.from({ length: 21 }, (_, i) => ({
            targetSessionId: `demo-${i}`,
            states: ["waiting"],
          })),
        }),
      });
      expect(tooManyResponse.status).toBe(400);
      const tooManyBody = (await tooManyResponse.json()) as { error?: string };
      expect(tooManyBody.error).toMatch(/must not exceed 20 entries/);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnInBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      spawnInBackgroundSpy.mockRestore();
      await server.stop();
    }
  });

  it("POST /projects creates an unconfigured project and returns 201 with derived id", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const projectDir = join(root, "demo-app");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Demo App", prefix: "stub", path: projectDir }),
      });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        id: string;
        entry: { configured: boolean; prefix: string; path: string };
        projects: Array<{ id: string; configured: boolean }>;
      };
      expect(payload.id).toBe("demo-app");
      expect(payload.entry.configured).toBe(false);
      expect(payload.entry.prefix).toBe("stub");
      expect(payload.entry.path).toBe(projectDir);
      expect(payload.projects.find((p) => p.id === "demo-app")?.configured).toBe(false);

      const list = await fetch(`http://127.0.0.1:${port}/projects`);
      const listed = (await list.json()) as Array<{ id: string; configured: boolean }>;
      expect(listed.find((p) => p.id === "demo-app")?.configured).toBe(false);

      const updatedDir = join(root, "updated");
      await mkdir(updatedDir, { recursive: true });
      const update = await fetch(`http://127.0.0.1:${port}/projects/demo-app`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Demo Two", prefix: "stub2", path: updatedDir }),
      });
      expect(update.status).toBe(200);
      const updated = (await update.json()) as {
        id: string;
        entry: { name: string; prefix: string; path: string };
      };
      expect(updated.id).toBe("demo-app");
      expect(updated.entry.name).toBe("Demo Two");
      expect(updated.entry.prefix).toBe("stub2");
      expect(updated.entry.path).toBe(updatedDir);

      const del = await fetch(`http://127.0.0.1:${port}/projects/demo-app`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);
      const removed = (await del.json()) as {
        removedKind: string;
        projects: Array<{ id: string }>;
      };
      expect(removed.removedKind).toBe("unconfigured");
      expect(removed.projects.find((p) => p.id === "demo-app")).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("GET /projects carries modes through the HTTP boundary and omits them for a modes-less project", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const plainRepoDir = join(root, "plain-repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    await mkdir(plainRepoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
        "    modes:",
        "      manager:",
        "        skill: manager",
        "        default: true",
        "  plain:",
        `    path: ${plainRepoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`);
      const listed = (await response.json()) as Array<{
        id: string;
        modes?: Record<string, { skill: string; default?: boolean }>;
      }>;
      expect(listed.find((p) => p.id === "demo")?.modes).toEqual({
        manager: { skill: "manager", default: true },
      });
      expect(listed.find((p) => p.id === "plain")).not.toHaveProperty("modes");
    } finally {
      await server.stop();
    }
  });

  it("POST /projects returns 400 when path does not exist without createMissing", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const missingPath = join(root, "missing", "child");
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Demo App", prefix: "stub", path: missingPath }),
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toBe(`path does not exist: ${missingPath}`);
      expect(fs.existsSync(missingPath)).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("POST /projects with createMissing creates the directory and returns 201", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const missingPath = join(root, "missing", "child");
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Demo App",
          prefix: "stub",
          path: missingPath,
          createMissing: true,
        }),
      });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        id: string;
        entry: { path: string };
      };
      expect(payload.id).toBe("demo-app");
      expect(payload.entry.path).toBe(missingPath);
      expect(fs.existsSync(missingPath)).toBe(true);
      expect(fs.statSync(missingPath).isDirectory()).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("POST /projects with createMissing still 400s when path is an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const filePath = join(root, "not-a-dir.txt");
    await writeFile(filePath, "hello", "utf8");
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Demo App",
          prefix: "stub",
          path: filePath,
          createMissing: true,
        }),
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toBe(`path is not a directory: ${filePath}`);
      expect(fs.statSync(filePath).isFile()).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("POST /projects derives folder under dataDir/projects when path omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Demo App", prefix: "stub" }),
      });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        id: string;
        entry: { path: string };
      };
      expect(payload.id).toBe("demo-app");
      const expectedPath = join(dataDir, "projects", "demo-app");
      expect(payload.entry.path).toBe(expectedPath);
      expect(fs.existsSync(expectedPath)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("POST /projects derives folder under configured projectsRoot when path omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projectsRoot: ./custom-root",
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Demo App", prefix: "stub" }),
      });
      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        id: string;
        entry: { path: string };
      };
      expect(payload.id).toBe("demo-app");
      const expectedPath = join(root, "custom-root", "demo-app");
      expect(payload.entry.path).toBe(expectedPath);
      expect(fs.existsSync(expectedPath)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("POST /projects returns 400 when path is provided but blank", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Demo App", prefix: "stub", path: "" }),
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toBe("path must be a non-empty string when provided");
    } finally {
      await server.stop();
    }
  });

  it("POST /projects rejects missing fields with 400", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "  ", prefix: "x", path: "/tmp" }),
      });
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toMatch(/displayName/);
    } finally {
      await server.stop();
    }
  });

  it("PATCH /projects/:id returns 400 for invalid JSON bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      for (const { body, error } of [
        { body: "not-json", error: "Invalid JSON in request body" },
        { body: "null", error: "Request body must be a JSON object" },
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}/projects/demo`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
        });
        const payload = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(payload.error).toBe(error);
      }
    } finally {
      await server.stop();
    }
  });

  it("DELETE /projects/:id returns 404 for unknown ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects/missing`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("routes slash command suggestion endpoints through the session service", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );

    const originalProjectSuggestions = SessionService.prototype.getProjectSuggestions;
    const originalSessionSuggestions = SessionService.prototype.getSessionSuggestions;
    SessionService.prototype.getProjectSuggestions = async function mockProjectSuggestions() {
      return { agent: "claude", commands: [], skills: [], agents: [] };
    };
    SessionService.prototype.getSessionSuggestions = async function mockSessionSuggestions() {
      return { agent: "codex", commands: [], skills: [], agents: [] };
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const projectResponse = await fetch(
        `http://127.0.0.1:${port}/projects/demo/slash-commands?agent=claude`,
      );
      expect(projectResponse.status).toBe(200);
      await expect(projectResponse.json()).resolves.toMatchObject({ agent: "claude" });

      const sessionResponse = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-a1/slash-commands`,
      );
      expect(sessionResponse.status).toBe(200);
      await expect(sessionResponse.json()).resolves.toMatchObject({ agent: "codex" });
    } finally {
      SessionService.prototype.getProjectSuggestions = originalProjectSuggestions;
      SessionService.prototype.getSessionSuggestions = originalSessionSuggestions;
      await server.stop();
    }
  });

  it("resolves spawn defaults so a client can preselect a concrete model and workspace mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
        "    worktree: false",
        "    defaultModels:",
        "      claude: sonnet",
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const claudeResponse = await fetch(
        `http://127.0.0.1:${port}/projects/demo/spawn-defaults?agent=claude`,
      );
      expect(claudeResponse.status).toBe(200);
      await expect(claudeResponse.json()).resolves.toEqual({ model: "sonnet", worktree: false });

      const codexResponse = await fetch(
        `http://127.0.0.1:${port}/projects/demo/spawn-defaults?agent=codex`,
      );
      expect(codexResponse.status).toBe(200);
      await expect(codexResponse.json()).resolves.toEqual({ model: null, worktree: false });

      const badAgentResponse = await fetch(
        `http://127.0.0.1:${port}/projects/demo/spawn-defaults?agent=nope`,
      );
      expect(badAgentResponse.status).toBe(400);

      const missingProjectResponse = await fetch(
        `http://127.0.0.1:${port}/projects/missing/spawn-defaults?agent=claude`,
      );
      expect(missingProjectResponse.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("disconnects a symlink alias and reconnects its fresh retarget", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const oldDir = join(root, "old");
    const freshDir = join(root, "fresh");
    const aliasDir = join(root, "alias");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  base:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const oldConfigPath = join(oldDir, "spur.yaml");
    const freshConfigPath = join(freshDir, "spur.yaml");
    await writeFile(
      oldConfigPath,
      ["projects:", "  old:", `    path: ${oldDir}`, "    sessionPrefix: old", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      freshConfigPath,
      ["projects:", "  fresh:", `    path: ${freshDir}`, "    sessionPrefix: fresh", ""].join("\n"),
      "utf8",
    );
    fs.symlinkSync(oldDir, aliasDir, "dir");
    const aliasConfigPath = join(aliasDir, "spur.yaml");

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const connectOld = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: aliasConfigPath }),
      });
      expect(connectOld.status).toBe(200);

      const disconnect = await fetch(`http://127.0.0.1:${port}/projects/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: aliasConfigPath }),
      });
      expect(disconnect.status).toBe(200);

      await rm(aliasDir);
      fs.symlinkSync(freshDir, aliasDir, "dir");

      const reconnect = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: aliasConfigPath }),
      });
      expect(reconnect.status).toBe(200);
      const payload = (await reconnect.json()) as { projects: Array<{ id: string }> };
      expect(payload.projects.some((project) => project.id === "fresh")).toBe(true);
      expect(payload.projects.some((project) => project.id === "old")).toBe(false);

      expect(readConfigRegistryFile(dataDir).configPaths).toEqual([
        fs.realpathSync(bootstrapConfigPath),
        fs.realpathSync(aliasConfigPath),
      ]);
      expect(fs.realpathSync(aliasConfigPath)).toBe(fs.realpathSync(freshConfigPath));
      expect(readConfigRegistryFile(dataDir).configPaths).not.toContain(
        fs.realpathSync(oldConfigPath),
      );
    } finally {
      await server.stop();
    }
  });

  it("DELETE /projects/:id disconnects a configured project without touching its spur.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const projectDir = join(root, "project");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  base:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const projectConfigPath = join(projectDir, "spur.yaml");
    const projectConfigContents = [
      "projects:",
      "  demo:",
      `    path: ${projectDir}`,
      "    sessionPrefix: demo-extra",
      "",
    ].join("\n");
    await writeFile(projectConfigPath, projectConfigContents, "utf8");
    const originalBytes = await readFile(projectConfigPath);
    const originalMtimeMs = fs.statSync(projectConfigPath).mtimeMs;

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const connect = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: projectConfigPath }),
      });
      expect(connect.status).toBe(200);

      const response = await fetch(`http://127.0.0.1:${port}/projects/demo`, { method: "DELETE" });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        removedKind: string;
        projects: Array<{ id: string }>;
      };
      expect(payload.removedKind).toBe("configured");
      expect(payload.projects.find((entry) => entry.id === "demo")).toBeUndefined();

      const subsequent = await fetch(`http://127.0.0.1:${port}/projects`);
      const listed = (await subsequent.json()) as Array<{ id: string }>;
      expect(listed.find((entry) => entry.id === "demo")).toBeUndefined();

      const afterBytes = await readFile(projectConfigPath);
      expect(afterBytes.equals(originalBytes)).toBe(true);
      expect(fs.statSync(projectConfigPath).mtimeMs).toBe(originalMtimeMs);
    } finally {
      await server.stop();
    }
  });

  it("rejects POST /projects/connect for a config inside worktreeDir with 400", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  base:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const worktreeConfigDir = join(worktreeDir, "proj", "sess");
    await mkdir(worktreeConfigDir, { recursive: true });
    const worktreeConfigPath = join(worktreeConfigDir, "spur.yaml");
    await writeFile(
      worktreeConfigPath,
      ["projects:", "  sess:", `    path: ${worktreeConfigDir}`, ""].join("\n"),
      "utf8",
    );

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: worktreeConfigPath }),
      });
      expect(response.status).toBe(400);
      expect(readConfigRegistryFile(dataDir).configPaths).not.toContain(worktreeConfigPath);
    } finally {
      await server.stop();
    }
  });

  it("drops a registered project directory at boot and rejects connecting one with 400", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const extraProjectDir = join(root, "extra-project");
    const extraConfigPath = join(extraProjectDir, "spur.yaml");
    await mkdir(extraProjectDir, { recursive: true });
    await writeFile(
      extraConfigPath,
      [
        "projects:",
        "  extra:",
        `    path: ${extraProjectDir}`,
        "    sessionPrefix: extra",
        "",
      ].join("\n"),
      "utf8",
    );

    writeConfigRegistryFile(dataDir, {
      configPaths: [extraProjectDir, extraConfigPath],
      unconfiguredProjects: [],
    });

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const bootRegistry = readConfigRegistryFile(dataDir);
      expect(bootRegistry.configPaths).not.toContain(extraProjectDir);
      expect(bootRegistry.configPaths).toContain(fs.realpathSync(extraConfigPath));

      const response = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: extraProjectDir }),
      });
      expect(response.status).toBe(400);
      const finalRegistry = readConfigRegistryFile(dataDir);
      expect(finalRegistry.configPaths).not.toContain(extraProjectDir);
      expect(finalRegistry.configPaths).toContain(fs.realpathSync(extraConfigPath));
    } finally {
      await server.stop();
    }
  });

  it("rejects POST /projects/disconnect for a relative configPath with 400 instead of resolving it against the daemon cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  base:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/projects/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: "spur.yaml" }),
      });
      expect(response.status).toBe(400);

      const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
      const listed = (await projectsResponse.json()) as Array<{ id: string }>;
      expect(listed.find((entry) => entry.id === "base")).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  it("POST /projects/connect removes the matching unconfigured stub in a single registry write", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const projectDir = join(root, "xyz-project");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const connectedConfigPath = join(projectDir, "spur.yaml");
    await writeFile(
      connectedConfigPath,
      ["projects:", "  xyz:", `    path: ${projectDir}`, "    sessionPrefix: xyz", ""].join("\n"),
      "utf8",
    );

    const registryPath = join(dataDir, "config-registry.json");
    const seededRegistry: ConfigRegistryFile = {
      configPaths: [],
      unconfiguredProjects: [
        { id: "xyz", displayName: "Xyz Stub", prefix: "xyz", path: projectDir },
      ],
    };
    writeConfigRegistryFile(dataDir, seededRegistry);

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    // writeJsonFile writes a sibling ".tmp.<pid>.<ts>" file then atomically renames it
    // onto the registry path. Watching the data dir, each registry mutation produces
    // a fresh tmp filename, so counting unique tmp filenames during the connect call
    // gives the number of logical registry writes.
    const tmpRenamesSeen = new Set<string>();
    const dirWatcher = fs.watch(dataDir, (eventType, filename) => {
      if (!filename) return;
      if (eventType !== "rename") return;
      if (!filename.startsWith("config-registry.json.tmp.")) return;
      tmpRenamesSeen.add(filename);
    });

    try {
      // Drain any startup-related events that may arrive after the watcher attaches.
      await new Promise((resolve) => setTimeout(resolve, 50));
      tmpRenamesSeen.clear();

      const response = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configPath: connectedConfigPath }),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: boolean;
        projects: Array<{ id: string }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.projects.find((entry) => entry.id === "xyz")).toBeDefined();

      // Allow watcher events scheduled during the connect call to be observed.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const finalRegistry = readConfigRegistryFile(dataDir);
      expect(finalRegistry.unconfiguredProjects).toEqual([]);
      expect(finalRegistry.configPaths).toContain(connectedConfigPath);

      const persisted = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as ConfigRegistryFile;
      expect(persisted.unconfiguredProjects).toEqual([]);

      expect(tmpRenamesSeen.size).toBe(1);
    } finally {
      dirWatcher.close();
      await server.stop();
    }
  });

  it("refuses to bind the production port from a non-default config path", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-prod-slot-test-"));
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      ["server:", "  port: 4310", `dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`].join("\n"),
      "utf8",
    );

    let started: StartedServer | undefined;
    try {
      await expect(
        startServer(configPath, {
          info: () => undefined,
          warn: () => undefined,
        }).then((server) => {
          started = server;
          return server;
        }),
      ).rejects.toThrow(/4310/);
    } finally {
      await started?.stop();
    }

    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(worktreeDir)).toBe(false);
  });

  it("prunes an orphan registry path at boot and logs a duplicate-project warning once across repeated connects", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });

    const bootstrapConfigPath = join(root, "spur.yaml");
    await writeFile(
      bootstrapConfigPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    // Orphan: file and parent directory are gone before daemon boot.
    const orphanDir = join(root, "orphan-dir");
    const orphanConfigPath = join(orphanDir, "spur.yaml");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(orphanConfigPath, "projects:\n  ghost:\n    path: /tmp/ghost\n", "utf8");
    await rm(orphanDir, { recursive: true, force: true });
    const missingParentAlivePath = join(root, "temporarily-missing.yaml");

    writeConfigRegistryFile(dataDir, {
      configPaths: [orphanConfigPath, missingParentAlivePath],
      unconfiguredProjects: [],
    });

    // Duplicate: this config conflicts with the bootstrap "demo" project id.
    const duplicateProjectDir = join(root, "dup-project");
    const duplicateConfigPath = join(duplicateProjectDir, "spur.yaml");
    await mkdir(duplicateProjectDir, { recursive: true });
    await writeFile(
      duplicateConfigPath,
      [
        "projects:",
        "  demo:",
        `    path: ${duplicateProjectDir}`,
        "    sessionPrefix: demo-dup",
        "",
      ].join("\n"),
      "utf8",
    );

    const server = await startServer(bootstrapConfigPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const bootRegistry = readConfigRegistryFile(dataDir);
      expect(bootRegistry.configPaths).not.toContain(orphanConfigPath);
      expect(bootRegistry.configPaths).toContain(missingParentAlivePath);
      expect(readEventLog(dataDir).some((entry) => entry.event.endsWith(".pruned"))).toBe(false);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/projects/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configPath: duplicateConfigPath }),
        });
        expect(response.status).toBe(200);
      }

      const finalRegistry = readConfigRegistryFile(dataDir);
      expect(finalRegistry.configPaths).not.toContain(orphanConfigPath);
      expect(finalRegistry.configPaths).toContain(missingParentAlivePath);
      expect(finalRegistry.configPaths).toContain(fs.realpathSync(duplicateConfigPath));
    } finally {
      await server.stop();
    }

    // Both registry problems are distinct but share level+event+sessionId, so
    // warn collapse holds the second until a flush. Shutdown flushes it, which
    // is why this reads the log after stop() rather than inside the try.
    const registryWarnings = readEventLog(dataDir).filter(
      (entry) => entry.event === "daemon.registry.warning",
    );
    expect(registryWarnings).toHaveLength(2);
  });
});
