import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSession } from "../../src/metadata.js";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { StoreService } from "../../src/stores.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0)) await stop();
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
  const root = await createTempDir("spur-server-actions-");
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
  const sends: Array<{ sessionId: string; message: string; queue: boolean | undefined }> = [];
  vi.spyOn(SessionService.prototype, "send").mockImplementation(async (sessionId, request) => {
    sends.push({ sessionId, message: request.message, queue: request.queue });
    return {} as Awaited<ReturnType<SessionService["send"]>>;
  });
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  stops.push(() => server.stop());
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  // A second handle on the same files, for seeding docs the HTTP surface cannot write.
  const seed = new StoreService({ dataDir, readSession: (id) => ({ id, status: "running" }) });
  return { call, sends, seed };
}

const invoke = (id: string) => ({
  id,
  action: "save",
  label: "Save",
  source: { kind: "snippet", snippetId: "form", instanceId: "inst-0001", revision: 2 },
  payload: { text: "hello" },
  userGesture: true,
});

describe("store actions over HTTP", () => {
  it("round-trips a session-store action: invoke, envelope to the owner, complete, change row", async () => {
    const { call, sends } = await boot();
    const invoked = await call("POST", "/stores/session%3Ademo-1/actions", invoke("act-00000001"));
    expect(invoked.status).toBe(200);
    expect(invoked.body).toMatchObject({ id: "act-00000001", data: { status: "pending" } });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ sessionId: "demo-1", queue: true });
    expect(sends[0]?.message.split("\n")[0]).toBe("[spur-action v1]");
    expect(sends[0]?.message).toContain(
      '"$SPUR_SESSION_TOOL_DIR/spur" db session:demo-1 done act-00000001',
    );

    const done = await call("POST", "/stores/session%3Ademo-1/actions/act-00000001/complete", {
      status: "done",
      result: { saved: true },
    });
    expect(done.body).toMatchObject({ data: { status: "done", result: { saved: true } } });
    const doc = await call("GET", "/stores/session%3Ademo-1/docs/_actions/act-00000001");
    expect(doc.body).toMatchObject({ data: { status: "done" } });
    const changes = await call("GET", "/stores/session%3Ademo-1/changes?since=0");
    expect(
      (changes.body.changes as Array<{ id: string; rev: number }>).map((change) => [
        change.id,
        change.rev,
      ]),
    ).toEqual([
      ["act-00000001", 1],
      ["act-00000001", 2],
    ]);
    expect(
      (await call("POST", "/stores/session%3Ademo-1/docs/_actions/act-x", { data: {} })).status,
    ).toBe(400);
  });

  it("refuses invoke on a terminal session store", async () => {
    const { call, sends } = await boot();
    expect(
      (await call("POST", "/stores/session%3Ademo-2/actions", invoke("act-00000001"))).status,
    ).toBe(409);
    expect(sends).toHaveLength(0);
  });

  it("returns a stale pending action as failed/timeout on every read path", async () => {
    const { call, seed } = await boot();
    const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    for (const id of ["act-stale-01", "act-stale-02", "act-stale-03", "act-stale-04"]) {
      await seed.insertIfAbsent("session:demo-1", "_actions", id, {
        action: "save",
        status: "pending",
        createdAt: stale,
      });
    }
    const base = "/stores/session%3Ademo-1";
    expect((await call("GET", `${base}/docs/_actions/act-stale-01`)).body).toMatchObject({
      data: { status: "failed", error: "timeout" },
    });
    const list = await call("GET", `${base}/docs/_actions`);
    expect(
      (list.body.docs as Array<{ data: { status: string } }>).every(
        (d) => d.data.status === "failed",
      ),
    ).toBe(true);
    const pending = await call("POST", `${base}/query/_actions`, {
      where: [{ field: "status", op: "==", value: "pending" }],
    });
    expect(pending.body.docs).toEqual([]);
    const changes = await call("GET", `${base}/changes?since=4`);
    expect((changes.body.changes as unknown[]).length).toBe(4);
    expect(
      (await call("POST", `${base}/actions/act-stale-01/complete`, { status: "done" })).status,
    ).toBe(409);
  });

  it("expires stale actions of a terminal session store on read while writes stay closed", async () => {
    const { call, seed } = await boot();
    await seed.insertIfAbsent("session:demo-2", "_actions", "act-stale-01", {
      action: "save",
      status: "pending",
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });
    const doc = await call("GET", "/stores/session%3Ademo-2/docs/_actions/act-stale-01");
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({ data: { status: "failed", error: "timeout" } });
    const changes = await call("GET", "/stores/session%3Ademo-2/changes?since=1");
    expect(changes.body.changes).toEqual([
      { seq: 2, collection: "_actions", id: "act-stale-01", op: "set", rev: 2 },
    ]);
    expect((await call("POST", "/stores/session%3Ademo-2/docs/notes", { data: {} })).status).toBe(
      409,
    );
  });
});
