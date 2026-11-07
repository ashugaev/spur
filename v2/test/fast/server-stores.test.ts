import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSession } from "../../src/metadata.js";
import { startServer } from "../../src/server.js";
import { pageDirPath } from "../../src/stores.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sessionRecord(
  id: string,
  status: SessionRecord["status"],
  repoDir: string,
): SessionRecord {
  return {
    id,
    project: "demo",
    workspaceId: id,
    agent: "claude",
    prompt: "ship it",
    branch: id,
    worktree: false,
    worktreePath: repoDir,
    tmuxSession: id,
    launchCommand: "claude",
    status,
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
  };
}

async function boot() {
  const root = await createTempDir("spur-server-stores-");
  roots.push(root);
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
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
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  writeSession(dataDir, sessionRecord("demo-1", "running", repoDir));
  writeSession(dataDir, sessionRecord("demo-2", "completed", repoDir));
  await mkdir(pageDirPath(dataDir, "films"), { recursive: true });
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, stop: () => server.stop() };
}

describe("store routes", () => {
  it("serves CRUD, query and changes with %3A-encoded store ids", async () => {
    const { call, stop } = await boot();
    try {
      const added = await call("POST", "/stores/page%3Afilms/docs/items", {
        data: { title: "Dune" },
      });
      expect(added.status).toBe(201);
      const id = added.body.id as string;
      expect((await call("GET", `/stores/page:films/docs/items/${id}`)).body).toMatchObject({
        data: { title: "Dune" },
        rev: 1,
      });
      expect(
        (
          await call("PATCH", `/stores/page%3Afilms/docs/items/${id}`, {
            data: { watched: true },
            expectedRev: 1,
          })
        ).body,
      ).toMatchObject({ rev: 2, data: { title: "Dune", watched: true } });
      expect(
        (
          await call("PATCH", `/stores/page%3Afilms/docs/items/${id}`, {
            data: { x: 1 },
            expectedRev: 1,
          })
        ).status,
      ).toBe(409);
      expect(
        (await call("POST", "/stores/page%3Afilms/docs/items/d2", { data: { title: "Arrival" } }))
          .status,
      ).toBe(200);
      const list = await call("GET", "/stores/page%3Afilms/docs/items?limit=1");
      expect((list.body.docs as unknown[]).length).toBe(1);
      const query = await call("POST", "/stores/page%3Afilms/query/items", {
        where: [{ field: "watched", op: "==", value: true }],
      });
      expect((query.body.docs as Array<{ id: string }>).map((doc) => doc.id)).toEqual([id]);
      expect(
        (await call("DELETE", "/stores/page%3Afilms/docs/items/d2?expectedRev=1")).body,
      ).toEqual({
        deleted: true,
      });
      const changes = await call("GET", "/stores/page%3Afilms/changes?since=1&limit=2");
      expect(changes.body).toEqual({
        changes: [
          { seq: 2, collection: "items", id, op: "set", rev: 2 },
          { seq: 3, collection: "items", id: "d2", op: "set", rev: 1 },
        ],
        lastSeq: 4,
      });
      expect((await call("GET", "/stores/page%3Afilms/changes?since=40")).body).toMatchObject({
        reset: true,
      });
    } finally {
      await stop();
    }
  });

  it("maps validation, missing, closed and oversize errors to statuses", async () => {
    const { call, stop } = await boot();
    try {
      expect((await call("GET", "/stores/bogus/docs/items")).status).toBe(400);
      expect((await call("GET", "/stores/page%3Anope/docs/items")).status).toBe(404);
      expect((await call("GET", "/stores/session%3Amissing/docs/items")).status).toBe(404);
      expect((await call("GET", "/stores/page%3Afilms/docs/items/none")).status).toBe(404);
      expect((await call("POST", "/stores/page%3Afilms/docs/_actions", { data: {} })).status).toBe(
        400,
      );
      expect(
        (
          await call("POST", "/stores/page%3Afilms/query/items", {
            where: [{ field: "a') --", op: "==", value: 1 }],
          })
        ).status,
      ).toBe(400);
      expect((await call("GET", "/stores/page%3Afilms/changes?since=-1")).status).toBe(400);
      expect(
        (
          await call("POST", "/stores/page%3Afilms/docs/items", {
            data: { blob: "x".repeat(300_000) },
          })
        ).status,
      ).toBe(413);
      expect(
        (await call("POST", "/stores/session%3Ademo-1/docs/notes", { data: { a: 1 } })).status,
      ).toBe(201);
      const closed = await call("POST", "/stores/session%3Ademo-2/docs/notes", { data: { a: 1 } });
      expect(closed.status).toBe(409);
      expect((await call("GET", "/stores/session%3Ademo-2/docs/notes")).status).toBe(200);
      // Bodies over 1 MB keep the daemon-wide readJsonBody behavior: 500.
      expect(
        (
          await call("POST", "/stores/page%3Afilms/docs/items", {
            data: { blob: "x".repeat(1_000_001) },
          })
        ).status,
      ).toBe(500);
    } finally {
      await stop();
    }
  });
});
