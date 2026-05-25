import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
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
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        port,
      });

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

      const del = await fetch(`http://127.0.0.1:${port}/projects/demo-app`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);
      const removed = (await del.json()) as { removedKind: string; projects: Array<{ id: string }> };
      expect(removed.removedKind).toBe("unconfigured");
      expect(removed.projects.find((p) => p.id === "demo-app")).toBeUndefined();
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
});
