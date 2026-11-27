import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEventLog, readEventLog, resetEventLogCollapse } from "../../src/event-log.js";
import { archiveSessions, sessionFilePath, writeSession } from "../../src/metadata.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import type { SessionRecord, WorkSnapshot } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function fixture(extraProjectYaml: string[] = []) {
  resetEventLogCollapse();
  const root = await createTempDir("spur-server-snapshots-");
  const dataDir = join(root, "data");
  const repoDir = join(root, "repo");
  const port = await findFreePort();
  await mkdir(repoDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-b", "main");
  git("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  test:",
      `    path: ${repoDir}`,
      ...extraProjectYaml,
    ].join("\n"),
  );
  const session: SessionRecord = {
    id: "snap-owner",
    project: "test",
    agent: "codex",
    model: "gpt-test",
    prompt: "Snapshot test",
    branch: "feature/snap",
    worktree: true,
    worktreePath: repoDir,
    tmuxSession: "snap-owner",
    launchCommand: "codex",
    status: "stopped",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    slots: { links: [{ label: "PR", url: "https://example.test/pr/1" }] },
  };
  writeSession(dataDir, session);
  writeSession(dataDir, { ...session, id: "snap-other", tmuxSession: "snap-other" });
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  servers.push(server);
  const url = `http://127.0.0.1:${port}/sessions`;
  const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/${id}/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { dataDir, session, url, post, repoDir };
}

const agentHeaders = (id: string) => ({ "x-spur-origin": "cli", "x-spur-caller-session": id });

describe("snapshot routes", () => {
  it("fills metadata for a session-owned write", async () => {
    const { post, url } = await fixture();
    const response = await post(
      "snap-owner",
      { content: "# Now\nstep" },
      agentHeaders("snap-owner"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      sessionId: "snap-owner",
      project: "test",
      agent: "codex",
      model: "gpt-test",
      branch: "main",
      dirty: false,
      todoRevision: "",
      links: [{ label: "PR", url: "https://example.test/pr/1" }],
      trigger: "manual",
      final: false,
    });
    const stored = (await fetch(`${url}/snap-owner/snapshots/1`).then((r) => r.json())) as {
      headSha: string;
    };
    expect(stored.headSha).toMatch(/^[0-9a-f]{40}$/);
    const full = await fetch(`${url}/snap-owner/snapshots/1`);
    expect(await full.json()).toMatchObject({ version: 1, content: "# Now\nstep" });
  });

  it("records a dirty worktree after an untracked file appears", async () => {
    const { post, repoDir } = await fixture();
    await writeFile(join(repoDir, "scratch.txt"), "x");
    const response = await post("snap-owner", { content: "dirty" }, { "x-spur-origin": "cli" });
    expect(await response.json()).toMatchObject({ dirty: true });
  });

  it("stores final writes and serves latest and the list", async () => {
    const { post, url } = await fixture();
    await post("snap-owner", { content: "one" }, { "x-spur-origin": "mcp" });
    const final = await post(
      "snap-owner",
      { content: "two", final: true },
      { "x-spur-origin": "mcp" },
    );
    expect(await final.json()).toMatchObject({ version: 2, final: true, trigger: "final" });
    const latest = await fetch(`${url}/snap-owner/snapshots/latest`);
    expect(await latest.json()).toMatchObject({ version: 2, content: "two" });
    const list = (await (await fetch(`${url}/snap-owner/snapshots`)).json()) as Array<
      Record<string, unknown>
    >;
    expect(list.map((entry) => entry["version"])).toEqual([1, 2]);
    expect(list[0]).not.toHaveProperty("content");
  });

  it("rejects a foreign caller session and stores nothing", async () => {
    const { post, dataDir } = await fixture();
    const response = await post("snap-owner", { content: "x" }, agentHeaders("snap-other"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    const mcp = await post(
      "snap-owner",
      { content: "x" },
      {
        "x-spur-origin": "mcp",
        "x-spur-caller-session": "snap-owner",
      },
    );
    expect(mcp.status).toBe(400);
    const dir = join(dataDir, "sessions", "snap-owner", "snapshots");
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("validates the body shape", async () => {
    const { post } = await fixture();
    const headers = { "x-spur-origin": "cli" };
    for (const body of [
      { content: "x", extra: 1 },
      { content: 3 },
      { content: "   " },
      {},
      { content: "x", final: "yes" },
      { content: "x", trigger: "timer" },
      "[1]",
      "{",
    ]) {
      const response = await post("snap-owner", body, headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    }
  });

  it("returns 400 for a body over 1MB", async () => {
    const { post, url } = await fixture();
    const response = await post("snap-owner", JSON.stringify({ content: "x".repeat(1_000_001) }), {
      "x-spur-origin": "cli",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    expect(await (await fetch(`${url}/snap-owner/snapshots`)).json()).toEqual([]);
  });

  it("refuses oversize content with both numbers", async () => {
    const { post } = await fixture(["    snapshots:", "      maxBytes: 10"]);
    const response = await post(
      "snap-owner",
      { content: "é".repeat(6) },
      { "x-spur-origin": "cli" },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "snapshot_too_large",
      limitBytes: 10,
      actualBytes: 12,
      error: "Snapshot is 12 bytes; limit is 10 bytes (projects.test.snapshots.maxBytes).",
    });
  });

  it("maps read errors", async () => {
    const { url } = await fixture();
    expect((await fetch(`${url}/snap-owner/snapshots/latest`)).status).toBe(404);
    expect((await fetch(`${url}/snap-owner/snapshots/3`)).status).toBe(404);
    expect((await fetch(`${url}/missing/snapshots`)).status).toBe(404);
    for (const version of ["0", "abc", "-1", "1.5"]) {
      const response = await fetch(`${url}/snap-owner/snapshots/${version}`);
      expect(response.status, version).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    }
  });

  it("refuses an agent complete without a final snapshot when requireFinal is set", async () => {
    const { dataDir, url } = await fixture(["    snapshots:", "      requireFinal: true"]);
    const headers = { "content-type": "application/json", ...agentHeaders("snap-owner") };
    const todo = (body: unknown) =>
      fetch(`${url}/snap-owner/todo`, { method: "POST", headers, body: JSON.stringify(body) });
    const added = (await (await todo({ action: "add", text: "step", reason: "why" })).json()) as {
      items: Array<{ id: string }>;
    };
    await todo({ action: "complete", itemId: added.items[0]?.id, reason: "done" });
    const response = await fetch(`${url}/snap-owner/complete`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "work_snapshot_required",
      sessionId: "snap-owner",
      required: "final",
    });
    expect(readEventLog(dataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          path: "/sessions/snap-owner/complete",
        }),
      ]),
    );
  });
});

type Privates = {
  conversationReaders: Map<string, unknown>;
  codexConversationReaders: Map<string, unknown>;
  conversationReadChain: Map<string, unknown>;
  withWorkspaceLifecycleLocks: <T>(id: string, task: () => Promise<T>) => Promise<T>;
  withPaneWriteLock: <T>(pane: string, task: () => Promise<T>) => Promise<T>;
  transitionsBinding?: { store: { observeState: (...args: unknown[]) => void } };
};

const privates = (server: StartedServer): Privates => server as unknown as Privates;

describe("snapshot reads", () => {
  function seed(
    dataDir: string,
    session: SessionRecord,
    versions: Array<{ at: string; content: string; headSha?: string | null }>,
  ): void {
    const dir = join(dataDir, "sessions", session.id, "snapshots");
    mkdirSync(dir, { recursive: true });
    versions.forEach((entry, index) => {
      const snapshot: WorkSnapshot = {
        version: index + 1,
        at: entry.at,
        sessionId: session.id,
        project: session.project,
        agent: session.agent,
        model: null,
        branch: "main",
        headSha: entry.headSha ?? null,
        dirty: false,
        todoRevision: "",
        links: [],
        trigger: "manual",
        final: false,
        content: entry.content,
      };
      writeFileSync(join(dir, `${index + 1}.json`), JSON.stringify(snapshot));
    });
  }

  const linked = (
    base: SessionRecord,
    id: string,
    overrides: Partial<SessionRecord> = {},
  ): SessionRecord => ({
    ...base,
    id,
    // Codex reads also scan the host's global rollout dir; claude has no transcript here.
    agent: "claude",
    tmuxSession: id,
    slots: { links: [{ label: "pr", url: "https://example.test/pr/1" }] },
    ...overrides,
  });

  it("serves latest with freshness and exact content", async () => {
    const { dataDir, session, post, url, repoDir } = await fixture();
    writeSession(dataDir, linked(session, session.id));
    await post("snap-owner", { content: "# Now\nstep" }, agentHeaders("snap-owner"));
    const read = async () =>
      (await (await fetch(`${url}/snap-owner/snapshots/latest`)).json()) as {
        content: string;
        freshness: Record<string, unknown>;
      };
    const first = await read();
    expect(first.content).toBe("# Now\nstep");
    expect(first.freshness).toEqual({
      ageSeconds: expect.any(Number),
      activitySince: null,
      commitsSince: 0,
      stale: false,
    });
    execFileSync(
      "git",
      ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "more"],
      { cwd: repoDir, stdio: "pipe" },
    );
    expect((await read()).freshness["commitsSince"]).toBe(1);
    const version = (await (await fetch(`${url}/snap-owner/snapshots/1`)).json()) as {
      freshness: unknown;
    };
    expect(version.freshness).toMatchObject({ commitsSince: 1 });
  });

  it("lists with order, limit and cursors, and keeps the default oldest first", async () => {
    const { dataDir, session, url } = await fixture();
    seed(
      dataDir,
      session,
      ["a", "b", "c", "d"].map((content, i) => ({
        at: `2026-11-01T00:0${i}:00.000Z`,
        content,
      })),
    );
    const versions = async (query: string): Promise<number[]> =>
      (
        (await (await fetch(`${url}/snap-owner/snapshots${query}`)).json()) as Array<{
          version: number;
        }>
      ).map((entry) => entry.version);
    expect(await versions("")).toEqual([1, 2, 3, 4]);
    expect(await versions("?order=desc")).toEqual([4, 3, 2, 1]);
    expect(await versions("?order=desc&limit=2")).toEqual([4, 3]);
    expect(await versions("?order=desc&limit=2&before=3")).toEqual([2, 1]);
    expect(await versions("?limit=2&after=1")).toEqual([2, 3]);
    expect(await versions("?after=1&before=4")).toEqual([2, 3]);
    expect(await versions("?after=3&before=4")).toEqual([]);
    for (const bad of [
      "?limit=0",
      "?limit=101",
      "?before=x",
      "?after=0",
      "?order=up",
      "?limit=1&limit=2",
    ]) {
      const response = await fetch(`${url}/snap-owner/snapshots${bad}`);
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    }
  });

  it("returns each matching session's latest, newest first, with status and state", async () => {
    const { dataDir, session, url } = await fixture();
    const completed = linked(session, "snap-done", { status: "completed" });
    const archived = linked(session, "snap-arch", { status: "completed" });
    const unmatched = linked(session, "snap-corrupt", {
      slots: { links: [{ label: "pr", url: "https://example.test/pr/2" }] },
    });
    const empty = linked(session, "snap-empty");
    for (const record of [linked(session, session.id), completed, archived, unmatched, empty]) {
      writeSession(dataDir, record);
    }
    seed(dataDir, session, [
      { at: "2026-11-02T00:00:00.000Z", content: "owner old" },
      { at: "2026-11-03T00:00:00.000Z", content: "owner new" },
    ]);
    seed(dataDir, completed, [{ at: "2026-11-05T00:00:00.000Z", content: "done" }]);
    seed(dataDir, archived, [{ at: "2026-11-04T00:00:00.000Z", content: "archived" }]);
    mkdirSync(join(dataDir, "sessions", unmatched.id, "snapshots"), { recursive: true });
    writeFileSync(join(dataDir, "sessions", unmatched.id, "snapshots", "1.json"), "{not json");
    archiveSessions(dataDir, [archived]);
    privates(servers[0] as StartedServer).transitionsBinding?.store.observeState(
      session,
      "waiting",
      [],
    );

    const response = await fetch(
      `${url.replace("/sessions", "")}/snapshots/latest?link=PR=https://example.test/pr/1`,
    );
    expect(response.status).toBe(200);
    const entries = (await response.json()) as Array<{
      sessionId: string;
      status: string;
      state: string | null;
      snapshot: { content: string; version: number; freshness: unknown };
    }>;
    expect(entries.map((entry) => entry.sessionId)).toEqual([
      "snap-done",
      "snap-arch",
      "snap-owner",
    ]);
    expect(entries.map((entry) => entry.snapshot.content)).toEqual([
      "done",
      "archived",
      "owner new",
    ]);
    expect(entries.map((entry) => entry.status)).toEqual(["completed", "completed", "stopped"]);
    // Ended records publish their status-derived state at write time.
    expect(entries.map((entry) => entry.state)).toEqual(["stopped", "stopped", "waiting"]);
    expect(entries[2]?.snapshot.version).toBe(2);
    expect(entries[0]?.snapshot.freshness).toMatchObject({ activitySince: null, stale: false });
  });

  it("rejects a missing or malformed link", async () => {
    const { url } = await fixture();
    const base = url.replace("/sessions", "");
    for (const query of ["", "?link=", "?link=PR=not a url", "?includeDone=1"]) {
      const response = await fetch(`${base}/snapshots/latest${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    }
    expect((await fetch(`${base}/snapshots/latest?link=PR&includeDone=yes`)).status).toBe(400);
  });

  it("reads archived sessions, also after logging recreates the live directory", async () => {
    const { dataDir, session, url } = await fixture();
    const archived = linked(session, "snap-arch", { agent: "claude", status: "completed" });
    const archivedCodex = linked(session, "snap-arch-codex", {
      agent: "codex",
      status: "completed",
    });
    for (const record of [archived, archivedCodex]) {
      writeSession(dataDir, record);
      seed(dataDir, record, [
        { at: "2026-11-02T00:00:00.000Z", content: `${record.id} one` },
        { at: "2026-11-03T00:00:00.000Z", content: `${record.id} two` },
      ]);
    }
    archiveSessions(dataDir, [archived, archivedCodex]);
    for (const record of [archived, archivedCodex]) {
      appendEventLog(dataDir, { event: "test.after_archive", level: "info", sessionId: record.id });
      expect(existsSync(join(dataDir, "sessions", record.id))).toBe(true);
    }
    const base = url.replace("/sessions", "");
    for (const record of [archived, archivedCodex]) {
      const latest = await fetch(`${url}/${record.id}/snapshots/latest`);
      // Codex also scans the host's global rollout dir, so only commitsSince is stable for it.
      expect(await latest.json()).toMatchObject({
        content: `${record.id} two`,
        freshness: {
          commitsSince: null,
          ...(record.agent === "claude" ? { activitySince: null } : {}),
        },
      });
      expect(await (await fetch(`${url}/${record.id}/snapshots/1`)).json()).toMatchObject({
        content: `${record.id} one`,
      });
      const history = (await (
        await fetch(`${url}/${record.id}/snapshots?order=desc`)
      ).json()) as Array<{ version: number }>;
      expect(history.map((entry) => entry.version)).toEqual([2, 1]);
    }
    const byLink = (await (
      await fetch(`${base}/snapshots/latest?link=PR=https://example.test/pr/1`)
    ).json()) as Array<{ sessionId: string; snapshot: { content: string } }>;
    expect(byLink.map((entry) => entry.snapshot.content).sort()).toEqual([
      "snap-arch two",
      "snap-arch-codex two",
    ]);
    const maps = privates(servers[0] as StartedServer);
    for (const record of [archived, archivedCodex]) {
      expect(maps.conversationReaders.has(record.id)).toBe(false);
      expect(maps.codexConversationReaders.has(record.id)).toBe(false);
      expect(maps.conversationReadChain.has(record.id)).toBe(false);
    }
  });

  it("answers 404 for an unknown session or version", async () => {
    const { url } = await fixture();
    expect((await fetch(`${url}/missing/snapshots/latest`)).status).toBe(404);
    expect((await fetch(`${url}/missing/snapshots/latest?includeDone=1`)).status).toBe(404);
  });

  it("lists completed ToDo items on request and tolerates a torn or damaged ledger", async () => {
    const { dataDir, session, url, post } = await fixture();
    await post("snap-owner", { content: "mine" }, agentHeaders("snap-owner"));
    const other = linked(session, "snap-other", {});
    writeSession(dataDir, linked(session, session.id));
    writeSession(dataDir, other);
    seed(dataDir, other, [{ at: "2026-11-02T00:00:00.000Z", content: "other" }]);
    const headers = { "content-type": "application/json", ...agentHeaders("snap-owner") };
    const todo = (body: unknown) =>
      fetch(`${url}/snap-owner/todo`, { method: "POST", headers, body: JSON.stringify(body) });
    const read = async (query = "") =>
      (await (await fetch(`${url}/snap-owner/snapshots/latest${query}`)).json()) as {
        done?: Array<{ text: string }>;
      };

    expect((await read("?includeDone=1")).done).toEqual([]);
    const added = (await (
      await todo({ action: "add", text: "finished", reason: "why" })
    ).json()) as {
      items: Array<{ id: string }>;
    };
    await todo({ action: "add", text: "open", reason: "why" });
    await todo({ action: "complete", itemId: added.items[0]?.id, reason: "done" });
    expect(await read()).not.toHaveProperty("done");
    expect((await read("?includeDone=1")).done?.map((item) => item.text)).toEqual(["finished"]);

    const ledger = join(dataDir, "sessions", "snap-owner", "todo.jsonl");
    appendFileSync(ledger, '{"version":1,"event');
    expect((await read("?includeDone=1")).done?.map((item) => item.text)).toEqual(["finished"]);

    appendFileSync(ledger, "\nnot json\n");
    const single = await fetch(`${url}/snap-owner/snapshots/latest?includeDone=1`);
    expect(single.status).toBe(500);
    expect(await single.json()).toMatchObject({ code: "todo_ledger_corrupt" });
    const byLink = (await (
      await fetch(
        `${url.replace("/sessions", "")}/snapshots/latest?link=PR=https://example.test/pr/1&includeDone=1`,
      )
    ).json()) as Array<{ sessionId: string; snapshot: { done?: unknown; content: string } }>;
    expect(Object.fromEntries(byLink.map((e) => [e.sessionId, e.snapshot.done]))).toEqual({
      "snap-owner": null,
      "snap-other": [],
    });
  });

  it("reads a stale-parked session without restoring, waking or touching its record", async () => {
    const { dataDir, session, url } = await fixture();
    const parked = linked(session, session.id, { stopReason: "stale_timeout" });
    writeSession(dataDir, parked);
    seed(dataDir, parked, [{ at: "2026-11-02T00:00:00.000Z", content: "parked" }]);
    const path = sessionFilePath(dataDir, parked.project, parked.id);
    const before = readFileSync(path);
    const names = [
      "restore",
      "reopen",
      "dispatchWake",
      "scheduleWake",
      "relaunchSessionInPlace",
      "finishStaleWake",
    ];
    const proto = SessionService.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const spies = names.map((name) => vi.spyOn(proto, name));
    try {
      const base = url.replace("/sessions", "");
      const single = await fetch(`${url}/snap-owner/snapshots/latest?includeDone=1`);
      expect(single.status).toBe(200);
      const byLink = await fetch(`${base}/snapshots/latest?link=PR=https://example.test/pr/1`);
      expect(byLink.status).toBe(200);
      expect((await byLink.json()) as unknown[]).toHaveLength(1);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
      spies.forEach((spy, index) => expect(spy, names[index]).not.toHaveBeenCalled());
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("resolves both reads while the lifecycle and pane locks are held", async () => {
    const { dataDir, session, url } = await fixture();
    seed(dataDir, session, [{ at: "2026-11-02T00:00:00.000Z", content: "locked" }]);
    const service = privates(servers[0] as StartedServer);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = service.withWorkspaceLifecycleLocks(session.id, () => hold);
    const pane = service.withPaneWriteLock(session.tmuxSession, () => hold);
    try {
      const timeout = AbortSignal.timeout(2000);
      const single = await fetch(`${url}/snap-owner/snapshots/latest`, { signal: timeout });
      expect(single.status).toBe(200);
      const byLink = await fetch(
        `${url.replace("/sessions", "")}/snapshots/latest?link=PR=https://example.test/pr/1`,
        { signal: timeout },
      );
      expect(byLink.status).toBe(200);
    } finally {
      release();
      await Promise.all([lifecycle, pane]);
    }
  });
});
