import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { findFreePort } from "../helpers/common.js";

async function setupConfig(): Promise<{ configPath: string; dataDir: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "spur-server-todo-events-test-"));
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

  it("logs a warn event for todo_open_work", async () => {
    const { configPath, dataDir, port } = await setupConfig();
    const originalComplete = SessionService.prototype.complete;
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      throw new TodoOpenWorkError([{ sessionId, openItemIds: ["item-1"], heldItemIds: [] }]);
    };
    try {
      const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
      runningServers.push(server);
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
    const { configPath, dataDir, port } = await setupConfig();
    const originalComplete = SessionService.prototype.complete;
    SessionService.prototype.complete = async function mockComplete(sessionId: string) {
      throw new TodoEmptyLedgerError([sessionId]);
    };
    try {
      const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
      runningServers.push(server);
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
    const { configPath, dataDir, port } = await setupConfig();
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    runningServers.push(server);
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
    const { configPath, dataDir, port } = await setupConfig();
    const originalMutateTodo = SessionService.prototype.mutateTodo;
    SessionService.prototype.mutateTodo = async function mockMutateTodo(sessionId: string) {
      throw new TodoTransitionConflictError(sessionId, "item-1", "item already resolved");
    };
    try {
      const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
      runningServers.push(server);
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
    const { configPath, dataDir, port } = await setupConfig();
    const originalMutateTodo = SessionService.prototype.mutateTodo;
    SessionService.prototype.mutateTodo = async function mockMutateTodo(sessionId: string) {
      throw new TodoLedgerCorruptError(sessionId, "unparsable line", 3);
    };
    try {
      const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
      runningServers.push(server);
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
});
