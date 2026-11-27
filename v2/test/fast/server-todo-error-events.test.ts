import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readEventLog, resetEventLogCollapse } from "../../src/event-log.js";
import { startServer, type StartedServer } from "../../src/server.js";
import {
  TodoEmptyLedgerError,
  TodoLedgerCorruptError,
  TodoOpenWorkError,
  TodoTransitionConflictError,
} from "../../src/todo.js";
import { SessionService } from "../../src/session-service.js";
import { startOnFreePort } from "../helpers/common.js";

async function setupConfig(
  port: number,
): Promise<{ configPath: string; dataDir: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "spur-server-todo-events-test-"));
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  const worktreeDir = join(root, "worktrees");
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
  return { configPath, dataDir, port };
}

// Servers are stopped only in afterAll, not per-case: server.stop() itself
// calls flushEventLogCollapse(dataDir), which would incidentally clear the
// module-global collapse map between cases and mask the need for the
// per-case resetEventLogCollapse() below. Keeping every server alive until
// the end of the file forces the four warn-level cases (same collapse key:
// level+event, no sessionId on any of these branches) to actually collide
// unless each case resets the collapse state itself.
const runningServers: StartedServer[] = [];

async function startTestServer(configure = setupConfig) {
  const { server, port } = await startOnFreePort(
    (_port, configPath) =>
      startServer(configPath, { info: () => undefined, warn: () => undefined }),
    async (candidate) => (await configure(candidate)).configPath,
  );
  runningServers.push(server);
  return { dataDir: server.config.dataDir, port };
}

afterAll(async () => {
  for (const server of runningServers) {
    await server.stop();
  }
});

describe("todo error branches log http.request.failed", () => {
  beforeEach(() => {
    // A module-global collapse map keys warn/error events on level+event only
    // (no dataDir), so an earlier case in this file would silently suppress
    // this case's event against the earlier case's dataDir. Reset it per case
    // so each assertion proves its own branch, not a leftover window.
    resetEventLogCollapse();
  });

  it("serves requests after retrying an occupied startup port", async () => {
    const blocker = createServer();
    let attempts = 0;
    try {
      const { port } = await startTestServer(async (candidate) => {
        attempts += 1;
        const config = await setupConfig(candidate);
        if (attempts === 1) {
          await new Promise<void>((resolve, reject) => {
            blocker.once("error", reject);
            blocker.listen(config.port, "127.0.0.1", resolve);
          });
        }
        return config;
      });
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect((await fetch(`http://127.0.0.1:${port}/info`)).status).toBe(200);
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("logs a warn event for todo_open_work", async () => {
    const originalComplete = SessionService.prototype.complete;
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      throw new TodoOpenWorkError([{ sessionId, openItemIds: ["item-1"], heldItemIds: [] }]);
    };
    try {
      const { dataDir, port } = await startTestServer();
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; sessions: unknown; error: string };
      expect(body.code).toBe("todo_open_work");
      expect(body.sessions).toBeDefined();
      expect(typeof body.error).toBe("string");

      const events = readEventLog(dataDir);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "http.request.failed",
            level: "warn",
            method: "POST",
            path: "/sessions/demo-1/complete",
            message: expect.any(String),
          }),
        ]),
      );
    } finally {
      SessionService.prototype.complete = originalComplete;
    }
  });

  it("logs a warn event for todo_ledger_empty", async () => {
    const originalComplete = SessionService.prototype.complete;
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      throw new TodoEmptyLedgerError([sessionId]);
    };
    try {
      const { dataDir, port } = await startTestServer();
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/complete`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; sessionId: string; error: string };
      expect(body.code).toBe("todo_ledger_empty");

      const events = readEventLog(dataDir);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "http.request.failed",
            level: "warn",
            method: "POST",
            path: "/sessions/demo-1/complete",
            message: expect.any(String),
          }),
        ]),
      );
    } finally {
      SessionService.prototype.complete = originalComplete;
    }
  });

  it("logs a warn event for invalid_todo_request driven by a real bad body", async () => {
    const { dataDir, port } = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/todo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-spur-origin": "ui" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_todo_request");

    const events = readEventLog(dataDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          method: "POST",
          path: "/sessions/demo-1/todo",
          message: expect.any(String),
        }),
      ]),
    );
  });

  it("logs a warn event for todo_transition_conflict", async () => {
    const originalMutateTodo = SessionService.prototype.mutateTodo;
    SessionService.prototype.mutateTodo = async function mockMutateTodo(sessionId: string) {
      throw new TodoTransitionConflictError(sessionId, "item-1", "item already resolved");
    };
    try {
      const { dataDir, port } = await startTestServer();
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/todo`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spur-origin": "ui" },
        body: JSON.stringify({ action: "complete", itemId: "item-1", reason: "done" }),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe("todo_transition_conflict");

      const events = readEventLog(dataDir);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "http.request.failed",
            level: "warn",
            method: "POST",
            path: "/sessions/demo-1/todo",
            message: expect.any(String),
          }),
        ]),
      );
    } finally {
      SessionService.prototype.mutateTodo = originalMutateTodo;
    }
  });

  it("logs an error event for todo_ledger_corrupt", async () => {
    const originalMutateTodo = SessionService.prototype.mutateTodo;
    SessionService.prototype.mutateTodo = async function mockMutateTodo(sessionId: string) {
      throw new TodoLedgerCorruptError(sessionId, "unparsable line", 3);
    };
    try {
      const { dataDir, port } = await startTestServer();
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/todo`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spur-origin": "ui" },
        body: JSON.stringify({ action: "complete", itemId: "item-1", reason: "done" }),
      });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe("todo_ledger_corrupt");

      const events = readEventLog(dataDir);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "http.request.failed",
            level: "error",
            method: "POST",
            path: "/sessions/demo-1/todo",
            message: expect.any(String),
          }),
        ]),
      );
    } finally {
      SessionService.prototype.mutateTodo = originalMutateTodo;
    }
  });

  it("logs a warn event for an auto-ping failure", async () => {
    const { dataDir, port } = await startTestServer();
    const response = await fetch(
      `http://127.0.0.1:${port}/sessions/demo-1/auto-ping-suppressions/mute`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-spur-origin": "ui" },
        body: JSON.stringify({ handle: "h-1", mode: "until_change" }),
      },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("session_not_found");
    expect(body.error.message).toBe("Auto-ping target session not found");

    const events = readEventLog(dataDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          method: "POST",
          path: "/sessions/demo-1/auto-ping-suppressions/mute",
          message: "Auto-ping target session not found",
        }),
      ]),
    );
  });
});
