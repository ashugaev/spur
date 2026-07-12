import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSession } from "../../src/metadata.js";
import { startServer } from "../../src/server.js";
import type { SessionRecord } from "../../src/types.js";
import { readUserActionLog } from "../../src/user-action-log.js";
import { findFreePort } from "../helpers/common.js";

const roots: string[] = [];

async function bootServer(): Promise<{
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "spur-user-actions-server-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  const worktreeDir = join(root, "worktrees");
  await mkdir(repoDir, { recursive: true });
  const port = await findFreePort();
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
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  return { port, dataDir, stop: () => server.stop() };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("user-action logging (server)", () => {
  it("logs exactly one record for a successful mutating request with the request origin", async () => {
    const { port, dataDir, stop } = await bootServer();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/demo-1/session-memory/decision.api`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-spur-origin": "ui" },
          body: JSON.stringify({ body: "Use HTTP API" }),
        },
      );
      expect(response.status).toBe(200);
    } finally {
      await stop();
    }

    const records = readUserActionLog(dataDir);
    expect(records).toHaveLength(1);
    const [entry] = records;
    expect(entry).toMatchObject({
      action: "session.memory_set",
      sessionId: "demo-1",
      origin: "ui",
      outcome: { ok: true },
    });
    expect(typeof entry?.latencyMs).toBe("number");
  });

  it("does not log read-only GET requests", async () => {
    const { port, dataDir, stop } = await bootServer();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions?view=dashboard`);
      expect(response.status).toBe(200);
    } finally {
      await stop();
    }
    expect(readUserActionLog(dataDir)).toHaveLength(0);
  });

  it("logs an unrecognized mutating route as action unknown", async () => {
    const { port, dataDir, stop } = await bootServer();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/nope`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spur-origin": "cli" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
    } finally {
      await stop();
    }
    const records = readUserActionLog(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: "unknown",
      origin: "cli",
      outcome: { status: 404, ok: false },
    });
    expect(records[0]?.sessionId).toBeUndefined();
  });
});
