import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import { _resetGhPathCacheForTests } from "../../src/gh.js";
import { writeSession } from "../../src/metadata.js";
import { startServer } from "../../src/server.js";
import {
  BacklogItemUnavailableError,
  OpenPrActionRequiredError,
  SessionNotRestorableError,
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

    expect(readEventLog(dataDir).map((entry) => entry.event)).toEqual([
      "daemon.startup.reconciled",
      "daemon.started",
      "http.route.not_found",
      "daemon.stopping",
      "daemon.stopped",
    ]);
    await expect(fetch(`http://127.0.0.1:${port}/info`)).rejects.toThrow();
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
        sidecars: [{ name: "dev", alive: true, ports: [] }],
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

  it("routes backlog list and take through the session service", async () => {
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
    const takeAvailableBacklog = SessionService.prototype.takeAvailableBacklog;
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
        },
      ];
    };
    SessionService.prototype.takeAvailableBacklog = async function mockTakeAvailableBacklog() {
      throw new BacklogItemUnavailableError("Backlog item is unavailable");
    };

    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    try {
      const availableResponse = await fetch(`http://127.0.0.1:${port}/backlog/available`);
      expect(availableResponse.status).toBe(200);
      await expect(availableResponse.json()).resolves.toMatchObject([{ key: "WEB-17" }]);

      const takeResponse = await fetch(`http://127.0.0.1:${port}/backlog/take`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "demo",
          backlogId: "features",
          externalId: "10001",
        }),
      });
      expect(takeResponse.status).toBe(409);
      await expect(takeResponse.json()).resolves.toEqual({
        error: "Backlog item is unavailable",
      });
    } finally {
      SessionService.prototype.listAvailableBacklog = listAvailableBacklog;
      SessionService.prototype.takeAvailableBacklog = takeAvailableBacklog;
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
      await expect(response.text()).resolves.toBe("artifact-bytes");
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
});
