import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_USER_ACTION_LOG_CONFIG,
  appendUserAction,
  buildUserActionRecord,
  deleteSessionUserActions,
  readSessionUserActions,
  readUserActionLog,
  sessionUserActionLogPath,
  setUserActionLogConfig,
  userActionLogPath,
  type BuildUserActionInput,
  type UserActionRecord,
} from "../../src/user-action-log.js";

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-user-action-"));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<UserActionRecord> = {}): UserActionRecord {
  return {
    ts: "2026-07-12T00:00:00.000Z",
    actor: "user",
    origin: "cli",
    action: "session.kill",
    method: "POST",
    path: "/sessions/demo-1/kill",
    outcome: { status: 200, ok: true },
    latencyMs: 5,
    ...overrides,
  };
}

beforeEach(() => {
  setUserActionLogConfig(DEFAULT_USER_ACTION_LOG_CONFIG);
});

afterEach(async () => {
  setUserActionLogConfig(DEFAULT_USER_ACTION_LOG_CONFIG);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("appendUserAction dual-write", () => {
  it("writes an identical line to the global log and the session shard", async () => {
    const dir = await makeDir();
    appendUserAction(dir, record({ sessionId: "demo-1" }));

    const global = await readFile(userActionLogPath(dir), "utf8");
    const shard = await readFile(sessionUserActionLogPath(dir, "demo-1"), "utf8");
    expect(global).toBe(shard);
    expect(global.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(global.trim())).toMatchObject({
      action: "session.kill",
      sessionId: "demo-1",
    });
  });

  it("writes only the global log when sessionId is absent", async () => {
    const dir = await makeDir();
    appendUserAction(dir, record({ action: "project.create", path: "/projects" }));

    expect(readUserActionLog(dir)).toHaveLength(1);
    expect(existsSync(sessionUserActionLogPath(dir, "demo-1"))).toBe(false);
  });
});

describe("rotation", () => {
  it("rotates the shard into a .1.gz archive and prunes beyond retainArchives", async () => {
    const dir = await makeDir();
    setUserActionLogConfig({ hotBytes: 1024 * 1024, shardHotBytes: 200, retainArchives: 2 });

    for (let i = 0; i < 40; i += 1) {
      appendUserAction(dir, record({ sessionId: "demo-1", latencyMs: i }));
    }

    const shardPath = sessionUserActionLogPath(dir, "demo-1");
    expect(existsSync(`${shardPath}.1.gz`)).toBe(true);
    // retainArchives=2 caps archive count at 2, pruning older archives.
    expect(existsSync(`${shardPath}.3.gz`)).toBe(false);
    // Pruning drops the oldest records; the newest ones remain readable, and the very
    // last append (latencyMs 39) survives in the live file.
    const remaining = readSessionUserActions(dir, "demo-1");
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(40);
    expect(remaining.at(-1)?.latencyMs).toBe(39);
  });
});

describe("read shard vs global", () => {
  it("returns only the requested session's records and respects limit", async () => {
    const dir = await makeDir();
    appendUserAction(dir, record({ sessionId: "demo-1", action: "session.send" }));
    appendUserAction(dir, record({ sessionId: "demo-2", action: "session.kill" }));
    appendUserAction(dir, record({ sessionId: "demo-1", action: "session.pause" }));

    const all = readSessionUserActions(dir, "demo-1");
    expect(all.map((entry) => entry.action)).toEqual(["session.send", "session.pause"]);

    const capped = readSessionUserActions(dir, "demo-1", { limit: 1 });
    expect(capped.map((entry) => entry.action)).toEqual(["session.pause"]);

    expect(readUserActionLog(dir)).toHaveLength(3);
  });
});

describe("deleteSessionUserActions", () => {
  it("removes the shard and its archives but leaves the global log intact", async () => {
    const dir = await makeDir();
    setUserActionLogConfig({ hotBytes: 1024 * 1024, shardHotBytes: 200, retainArchives: 2 });
    for (let i = 0; i < 40; i += 1) {
      appendUserAction(dir, record({ sessionId: "demo-1", latencyMs: i }));
    }
    const shardPath = sessionUserActionLogPath(dir, "demo-1");
    expect(existsSync(`${shardPath}.1.gz`)).toBe(true);

    deleteSessionUserActions(dir, "demo-1");

    expect(existsSync(shardPath)).toBe(false);
    expect(existsSync(`${shardPath}.1.gz`)).toBe(false);
    expect(existsSync(`${shardPath}.2.gz`)).toBe(false);
    expect(readUserActionLog(dir).length).toBeGreaterThan(0);
  });
});

function build(overrides: Partial<BuildUserActionInput>): UserActionRecord | null {
  return buildUserActionRecord({
    method: "POST",
    path: "/sessions/demo-1/kill",
    origin: "cli",
    body: {},
    statusCode: 200,
    latencyMs: 3,
    ...overrides,
  });
}

describe("buildUserActionRecord decoder", () => {
  it("never logs GET/HEAD/OPTIONS", () => {
    expect(build({ method: "GET", path: "/sessions" })).toBeNull();
    expect(build({ method: "HEAD", path: "/sessions/demo-1/kill" })).toBeNull();
    expect(build({ method: "OPTIONS", path: "/sessions" })).toBeNull();
  });

  it("decodes session.kill with sessionId and ok outcome", () => {
    const result = build({ path: "/sessions/demo-1/kill" });
    expect(result).toMatchObject({
      action: "session.kill",
      sessionId: "demo-1",
      origin: "cli",
      outcome: { status: 200, ok: true },
    });
    expect(typeof result?.ts).toBe("string");
  });

  it("matches nested routes before their prefixes", () => {
    expect(build({ path: "/sessions/demo-1/wake/cancel" })?.action).toBe("session.wake_cancel");
    expect(build({ path: "/sessions/demo-1/wake" })?.action).toBe("session.wake");
    expect(build({ path: "/sessions/demo-1/sidecars/mcp/stop" })?.action).toBe("sidecar.stop");
    expect(build({ path: "/sessions/demo-1/session-memory/k/resolve" })?.action).toBe(
      "session.memory_resolve",
    );
    expect(build({ path: "/sessions/demo-1/session-memory/k" })?.action).toBe("session.memory_set");
  });

  it("sub-decodes /slots by body keys", () => {
    expect(build({ path: "/sessions/demo-1/slots", body: { tags: ["a"] } })?.action).toBe(
      "session.retag",
    );
    expect(build({ path: "/sessions/demo-1/slots", body: { title: "t" } })?.action).toBe(
      "session.retitle",
    );
    expect(build({ path: "/sessions/demo-1/slots", body: { links: [] } })?.action).toBe(
      "session.relink",
    );
    expect(
      build({ path: "/sessions/demo-1/slots", body: { tags: ["a"], title: "t" } })?.action,
    ).toBe("session.update_slots");
    expect(build({ path: "/sessions/demo-1/slots", body: {} })?.action).toBe("unknown");
  });

  it("decodes project routes and non-2xx outcomes", () => {
    expect(build({ method: "PATCH", path: "/projects/demo" })).toMatchObject({
      action: "project.update",
      projectId: "demo",
    });
    expect(build({ method: "DELETE", path: "/projects/demo" })).toMatchObject({
      action: "project.delete",
      projectId: "demo",
    });
    const failed = build({ method: "POST", path: "/nope", statusCode: 404, error: "boom" });
    expect(failed).toMatchObject({
      action: "unknown",
      outcome: { status: 404, ok: false },
      error: "boom",
    });
    expect(failed?.sessionId).toBeUndefined();
  });
});

describe("buildUserActionRecord redaction/truncation", () => {
  it("stores a hashed, length-capped preview and never the full message", () => {
    const message = "x".repeat(500);
    const result = build({
      path: "/sessions/demo-1/send",
      body: { message, attachments: [{ name: "a", data: "b" }] },
    });
    const params = result?.params ?? {};
    expect(params["textLen"]).toBe(500);
    expect(String(params["textPreview"])).toHaveLength(120);
    expect(typeof params["textHash"]).toBe("string");
    expect(params["hasAttachment"]).toBe(true);
    expect(JSON.stringify(result)).not.toContain(message);
  });

  it("never persists non-whitelisted (sensitive) body fields", () => {
    const result = build({
      method: "POST",
      path: "/projects",
      body: { displayName: "Demo", prefix: "d", path: "/tmp/demo", apiKey: "super-secret-token" },
    });
    expect(result?.params).toEqual({ displayName: "Demo", prefix: "d", path: "/tmp/demo" });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });
});
