import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readEventLog, resetEventLogCollapse, type SpurLogEntry } from "../../src/event-log.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

async function setupConfig(): Promise<{ configPath: string; dataDir: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "spur-server-missing-resource-test-"));
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

// Servers stay alive until afterAll: server.stop() calls flushEventLogCollapse,
// which would clear the module-global collapse map between cases and mask the
// per-case resetEventLogCollapse() below. Every case in this file writes the
// same warn/http.request.failed collapse key (no sessionId on this branch), so
// without the reset the second case's entry is suppressed into the first
// case's 60s window and read back from a different dataDir.
const runningServers: StartedServer[] = [];

async function startFixture(): Promise<{ dataDir: string; port: number }> {
  const { configPath, dataDir, port } = await setupConfig();
  const server = await startServer(configPath, {
    info: () => undefined,
    warn: () => undefined,
  });
  runningServers.push(server);
  return { dataDir, port };
}

function errorLevelRequestFailures(dataDir: string): SpurLogEntry[] {
  return readEventLog(dataDir).filter(
    (entry) => entry.event === "http.request.failed" && entry.level === "error",
  );
}

afterAll(async () => {
  for (const server of runningServers) {
    await server.stop();
  }
});

describe("missing session and project ids answer 404 at warn level", () => {
  beforeEach(() => {
    resetEventLogCollapse();
  });

  const wakeModes: { name: string; body: Record<string, unknown> }[] = [
    { name: "schedule", body: { delayMs: 1000 } },
    { name: "update", body: { target: "scheduled", message: "x" } },
    { name: "dispatch", body: { target: "scheduled", dispatch: true } },
  ];

  for (const mode of wakeModes) {
    it(`POST /sessions/:id/wake (${mode.name} mode) returns 404 for a missing session`, async () => {
      const { dataDir, port } = await startFixture();
      const response = await fetch(`http://127.0.0.1:${port}/sessions/list/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode.body),
      });
      expect(response.status).toBe(404);

      expect(readEventLog(dataDir)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "http.request.failed",
            level: "warn",
            method: "POST",
            path: "/sessions/list/wake",
          }),
        ]),
      );
      expect(errorLevelRequestFailures(dataDir)).toEqual([]);
    });
  }

  it("POST /sessions/:id/wake/cancel returns 404 for a missing session", async () => {
    const { dataDir, port } = await startFixture();
    const response = await fetch(`http://127.0.0.1:${port}/sessions/list/wake/cancel`, {
      method: "POST",
    });
    expect(response.status).toBe(404);

    expect(readEventLog(dataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          method: "POST",
          path: "/sessions/list/wake/cancel",
        }),
      ]),
    );
    expect(errorLevelRequestFailures(dataDir)).toEqual([]);
  });

  // "background" is a real depth-2 literal route (POST /sessions/background),
  // so it pins that the fix lives at the throw site and is token-independent:
  // no depth-2 token is special-cased by the depth-3 wake route.
  it("POST /sessions/background/wake returns 404 for a missing session", async () => {
    const { dataDir, port } = await startFixture();
    const response = await fetch(`http://127.0.0.1:${port}/sessions/background/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delayMs: 1000 }),
    });
    expect(response.status).toBe(404);

    expect(readEventLog(dataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          method: "POST",
          path: "/sessions/background/wake",
        }),
      ]),
    );
    expect(errorLevelRequestFailures(dataDir)).toEqual([]);
  });

  it("GET /projects/:id/branches/exists returns 404 for a missing project", async () => {
    const { dataDir, port } = await startFixture();
    const response = await fetch(
      `http://127.0.0.1:${port}/projects/my-project/branches/exists?name=main`,
    );
    expect(response.status).toBe(404);

    expect(readEventLog(dataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          method: "GET",
          path: "/projects/my-project/branches/exists",
        }),
      ]),
    );
    expect(errorLevelRequestFailures(dataDir)).toEqual([]);
  });

  // Rows named "route regression" already answer 404 from an earlier entry
  // check, so they do not pin the later *Locked conversions. Those sites only
  // run when the session is deleted mid-operation; session-service.test.ts
  // "missing session lookups" pins them.
  const sessionRoutes: { name: string; method: "GET" | "POST"; path: string; body?: unknown }[] = [
    { name: "slash-commands", method: "GET", path: "/sessions/nope-1/slash-commands" },
    { name: "services list", method: "GET", path: "/sessions/nope-1/services" },
    { name: "services get", method: "GET", path: "/sessions/nope-1/services/web" },
    { name: "services run", method: "POST", path: "/sessions/nope-1/services/web/run", body: {} },
    { name: "send", method: "POST", path: "/sessions/nope-1/send", body: { message: "hi" } },
    { name: "answer", method: "POST", path: "/sessions/nope-1/answer", body: { optionIndex: 0 } },
    { name: "pause", method: "POST", path: "/sessions/nope-1/pause" },
    {
      name: "complete, route regression",
      method: "POST",
      path: "/sessions/nope-1/complete",
      body: {},
    },
    {
      name: "complete (desk scope)",
      method: "POST",
      path: "/sessions/nope-1/complete",
      body: { scope: "desk" },
    },
    { name: "kill", method: "POST", path: "/sessions/nope-1/kill", body: {} },
    {
      name: "restore, route regression",
      method: "POST",
      path: "/sessions/nope-1/restore",
      body: {},
    },
    {
      name: "handoff, route regression",
      method: "POST",
      path: "/sessions/nope-1/handoff",
      body: {},
    },
    { name: "respawn", method: "POST", path: "/sessions/nope-1/respawn", body: {} },
    {
      name: "switch-auth, route regression",
      method: "POST",
      path: "/sessions/nope-1/switch-auth",
      body: { accountId: "acct" },
    },
    {
      name: "sidecar start",
      method: "POST",
      path: "/sessions/nope-1/sidecars/web/start",
      body: {},
    },
    { name: "sidecar stop", method: "POST", path: "/sessions/nope-1/sidecars/web/stop" },
  ];

  for (const route of sessionRoutes) {
    it(`${route.method} ${route.path} (${route.name}) returns 404 for a missing session`, async () => {
      const { dataDir, port } = await startFixture();
      const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
        method: route.method,
        ...(route.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(route.body),
            }),
      });
      expect(response.status).toBe(404);
      expect(errorLevelRequestFailures(dataDir)).toEqual([]);
    });
  }
});
