import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_USER_ACTION_LOG_CONFIG,
  DEFAULT_USER_ACTION_LOG_HOT_BYTES,
  DEFAULT_USER_ACTION_LOG_RETAIN_ARCHIVES,
  DEFAULT_USER_ACTION_LOG_SHARD_HOT_BYTES,
  appendUserAction,
  buildUserActionRecord,
  deleteSessionUserActions,
  hasRecentSessionUserAction,
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

describe("retention defaults", () => {
  it("mirrors the event-log retention defaults: 128MB global, 16MB shard, 5 archives", () => {
    expect(DEFAULT_USER_ACTION_LOG_HOT_BYTES).toBe(128 * 1024 * 1024);
    expect(DEFAULT_USER_ACTION_LOG_SHARD_HOT_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_USER_ACTION_LOG_RETAIN_ARCHIVES).toBe(5);
  });
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

  it("bounds the global log to the last N records when limit is set", async () => {
    const dir = await makeDir();
    appendUserAction(dir, record({ sessionId: "demo-1", action: "session.send" }));
    appendUserAction(dir, record({ sessionId: "demo-2", action: "session.kill" }));
    appendUserAction(dir, record({ sessionId: "demo-1", action: "session.pause" }));

    const capped = readUserActionLog(dir, { limit: 2 });
    expect(capped.map((entry) => entry.action)).toEqual(["session.kill", "session.pause"]);

    expect(readUserActionLog(dir)).toHaveLength(3);
  });
});

describe("hasRecentSessionUserAction", () => {
  const actions = new Set(["session.send", "session.source_reply"]);

  it("returns false when the session has no shard yet", async () => {
    const dir = await makeDir();
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, 0)).toBe(false);
  });

  it("never falls back to the global log: a matching in-window entry there alone is not enough without a shard", async () => {
    const dir = await makeDir();
    // Write directly to the global log only — bypass appendUserAction so no
    // per-session shard gets created for demo-1.
    const line = `${JSON.stringify(
      record({ sessionId: "demo-1", action: "session.send", ts: "2026-07-12T00:00:10.000Z" }),
    )}\n`;
    writeFileSync(userActionLogPath(dir), line, { encoding: "utf-8", mode: 0o600 });
    expect(existsSync(sessionUserActionLogPath(dir, "demo-1"))).toBe(false);

    const sinceMs = Date.parse("2026-07-12T00:00:00.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(false);
  });

  it("returns true for a matching action inside the window", async () => {
    const dir = await makeDir();
    appendUserAction(
      dir,
      record({ sessionId: "demo-1", action: "session.send", ts: "2026-07-12T00:00:10.000Z" }),
    );
    const sinceMs = Date.parse("2026-07-12T00:00:00.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(true);
  });

  it("returns false for a matching action aged out of the window", async () => {
    const dir = await makeDir();
    appendUserAction(
      dir,
      record({ sessionId: "demo-1", action: "session.send", ts: "2026-07-12T00:00:00.000Z" }),
    );
    const sinceMs = Date.parse("2026-07-12T00:00:10.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(false);
  });

  it("returns false for a non-matching action type inside the window", async () => {
    const dir = await makeDir();
    appendUserAction(
      dir,
      record({ sessionId: "demo-1", action: "session.kill", ts: "2026-07-12T00:00:10.000Z" }),
    );
    const sinceMs = Date.parse("2026-07-12T00:00:00.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(false);
  });

  it("returns false for a different session id", async () => {
    const dir = await makeDir();
    appendUserAction(
      dir,
      record({ sessionId: "demo-2", action: "session.send", ts: "2026-07-12T00:00:10.000Z" }),
    );
    const sinceMs = Date.parse("2026-07-12T00:00:00.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(false);
  });

  it("only scans the live shard, not archived ones: a match rotated into a .gz archive is not found", async () => {
    const dir = await makeDir();
    // retainArchives=5 with only 4 padding appends keeps the matching record inside
    // retention (it lands in an archive, not evicted past it) — this matters because
    // if the padding count evicted it past every retained archive, this test would
    // pass identically whether hasRecentSessionUserAction correctly scans only the
    // live shard or incorrectly still walks archives too: the record wouldn't exist
    // anywhere either way. Each record here exceeds shardHotBytes on its own, so
    // every append rotates a single record straight into .1.gz and shifts prior
    // archives up by one; with retainArchives=5 the match survives through 4 shifts
    // and is pruned on the 5th, so 4 padding appends keeps it discoverable in an
    // archive (verified: reverting the live-shard-only fix makes this test fail).
    setUserActionLogConfig({ hotBytes: 1024 * 1024, shardHotBytes: 200, retainArchives: 5 });
    appendUserAction(
      dir,
      record({ sessionId: "demo-1", action: "session.send", ts: "2026-07-12T00:00:10.000Z" }),
    );
    for (let i = 0; i < 4; i += 1) {
      appendUserAction(dir, record({ sessionId: "demo-1", action: "session.kill", latencyMs: i }));
    }
    const shardPath = sessionUserActionLogPath(dir, "demo-1");
    expect(existsSync(`${shardPath}.1.gz`)).toBe(true);

    const sinceMs = Date.parse("2026-07-12T00:00:00.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(false);
  });

  it("finds a matching entry still in the live shard after other entries have rotated out", async () => {
    const dir = await makeDir();
    setUserActionLogConfig({ hotBytes: 1024 * 1024, shardHotBytes: 200, retainArchives: 2 });
    for (let i = 0; i < 40; i += 1) {
      appendUserAction(dir, record({ sessionId: "demo-1", action: "session.kill", latencyMs: i }));
    }
    const shardPath = sessionUserActionLogPath(dir, "demo-1");
    expect(existsSync(`${shardPath}.1.gz`)).toBe(true);

    // Raise the threshold so this append lands in — and stays in — the live shard
    // instead of immediately triggering another rotation.
    setUserActionLogConfig({
      hotBytes: 1024 * 1024,
      shardHotBytes: 1024 * 1024,
      retainArchives: 2,
    });
    appendUserAction(
      dir,
      record({ sessionId: "demo-1", action: "session.send", ts: "2026-07-12T00:00:10.000Z" }),
    );

    const sinceMs = Date.parse("2026-07-12T00:00:00.000Z");
    expect(hasRecentSessionUserAction(dir, "demo-1", actions, sinceMs)).toBe(true);
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

  it("removes higher-indexed archives after retainArchives is lowered, keeping the events shard", async () => {
    const dir = await makeDir();
    setUserActionLogConfig({ ...DEFAULT_USER_ACTION_LOG_CONFIG, retainArchives: 5 });
    appendUserAction(dir, record({ sessionId: "demo-2" }));
    const shardPath = sessionUserActionLogPath(dir, "demo-2");
    const shardDir = dirname(shardPath);
    // Archives written under the higher retain count, plus a co-located events shard.
    writeFileSync(`${shardPath}.5.gz`, "x");
    writeFileSync(`${shardPath}.3.gz`, "x");
    writeFileSync(join(shardDir, "events.jsonl"), "keep-me");

    // Config lowered before delete: the loop-bounded version would leak .3.gz/.5.gz.
    setUserActionLogConfig({ ...DEFAULT_USER_ACTION_LOG_CONFIG, retainArchives: 1 });
    deleteSessionUserActions(dir, "demo-2");

    expect(existsSync(shardPath)).toBe(false);
    expect(existsSync(`${shardPath}.5.gz`)).toBe(false);
    expect(existsSync(`${shardPath}.3.gz`)).toBe(false);
    expect(existsSync(join(shardDir, "events.jsonl"))).toBe(true);
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

  it("decodes session.reopen with sessionId", () => {
    expect(build({ path: "/sessions/demo-1/reopen" })).toMatchObject({
      action: "session.reopen",
      sessionId: "demo-1",
    });
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

  it("decodes shared-memory writes and removals with sessionId, not falling into session-memory", () => {
    const set = build({ path: "/sessions/demo-1/shared-memory/task/decision.api" });
    expect(set).toMatchObject({ action: "shared.memory_set", sessionId: "demo-1" });
    const remove = build({
      method: "DELETE",
      path: "/sessions/demo-1/shared-memory/project/gotcha.env",
    });
    expect(remove).toMatchObject({ action: "shared.memory_remove", sessionId: "demo-1" });
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
    expect(build({ method: "POST", path: "/projects/p1/preflight" })).toMatchObject({
      action: "project.preflight",
      projectId: "p1",
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

describe("buildUserActionRecord params (preview + whitelist)", () => {
  it("stores a length-capped cleartext preview plus hash, omitting the full message", () => {
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
