import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveSessions,
  deletePendingSendBatch,
  deleteTelegramSourceStateForSession,
  deleteWorkItemLifecycle,
  listSessions,
  readCommentSeenRegistry,
  readPendingSendBatches,
  readTelegramBindings,
  readTelegramLastUpdateId,
  readTelegramReplyTarget,
  readWorkItemLifecycles,
  readSession,
  readWorkItemRegistry,
  recordCommentSeen,
  recordPendingSendBatch,
  recordWorkItem,
  recordWorkItemLifecycle,
  writeTelegramBindings,
  writeTelegramReplyTarget,
  writeSession,
} from "../../src/metadata.js";
import { appendEventLog } from "../../src/event-log.js";
import type { PersistedPendingBatch, SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-meta-");
  tempDirs.push(dir);
  return dir;
}

describe("work-item registry", () => {
  it("round-trips recorded ids", async () => {
    const dataDir = await newDataDir();
    recordWorkItem(dataDir, "api", "pr-watch", "acme/api#1");
    recordWorkItem(dataDir, "api", "pr-watch", "acme/api#2");
    const ids = readWorkItemRegistry(dataDir, "api", "pr-watch");
    expect(ids.has("acme/api#1")).toBe(true);
    expect(ids.has("acme/api#2")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("returns an empty set when the registry file is missing", async () => {
    const dataDir = await newDataDir();
    const ids = readWorkItemRegistry(dataDir, "api", "pr-watch");
    expect(ids.size).toBe(0);
  });

  it("returns an empty set when the registry file is corrupt", async () => {
    const dataDir = await newDataDir();
    const dir = join(dataDir, "source-state", "github-work-items", "api");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pr-watch.json"), "{ not json", "utf8");
    const ids = readWorkItemRegistry(dataDir, "api", "pr-watch");
    expect(ids.size).toBe(0);
  });

  it("ignores duplicate records", async () => {
    const dataDir = await newDataDir();
    recordWorkItem(dataDir, "api", "pr-watch", "acme/api#1");
    recordWorkItem(dataDir, "api", "pr-watch", "acme/api#1");
    const ids = readWorkItemRegistry(dataDir, "api", "pr-watch");
    expect(ids.size).toBe(1);
  });
});

describe("comment-seen registry", () => {
  it("returns an empty set when the registry file is missing", async () => {
    const dataDir = await newDataDir();
    const ids = readCommentSeenRegistry(dataDir, "api", "pr-watch");
    expect(ids.size).toBe(0);
  });

  it("round-trips recorded ids", async () => {
    const dataDir = await newDataDir();
    recordCommentSeen(dataDir, "api", "pr-watch", ["101", "102"]);
    const ids = readCommentSeenRegistry(dataDir, "api", "pr-watch");
    expect(ids.has("101")).toBe(true);
    expect(ids.has("102")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("is idempotent when re-recording known ids", async () => {
    const dataDir = await newDataDir();
    recordCommentSeen(dataDir, "api", "pr-watch", ["101"]);
    recordCommentSeen(dataDir, "api", "pr-watch", ["101"]);
    recordCommentSeen(dataDir, "api", "pr-watch", ["101", "102"]);
    const ids = readCommentSeenRegistry(dataDir, "api", "pr-watch");
    expect(ids.size).toBe(2);
    expect(ids.has("101")).toBe(true);
    expect(ids.has("102")).toBe(true);
  });
});

describe("work-item lifecycle registry", () => {
  it("round-trips lifecycle records", async () => {
    const dataDir = await newDataDir();
    recordWorkItemLifecycle(dataDir, "api", "pr-watch", {
      externalId: "acme/api#7",
      state: "running",
      sessionId: "api-a1b2",
      url: "https://github.com/acme/api/pull/7",
      number: 7,
      title: "Review me",
      repo: "acme/api",
      createdAt: "2026-05-11T10:00:00.000Z",
      autoComplete: true,
    });

    expect(readWorkItemLifecycles(dataDir, "api", "pr-watch").get("acme/api#7")).toEqual({
      externalId: "acme/api#7",
      state: "running",
      sessionId: "api-a1b2",
      url: "https://github.com/acme/api/pull/7",
      number: 7,
      title: "Review me",
      repo: "acme/api",
      createdAt: "2026-05-11T10:00:00.000Z",
      autoComplete: true,
    });
  });

  it("reads legacy lifecycle records as running auto-complete claims", async () => {
    const dataDir = await newDataDir();
    const dir = join(dataDir, "source-state", "work-item-lifecycle", "api");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "pr-watch.json"),
      JSON.stringify(
        {
          records: [
            {
              externalId: "acme/api#7",
              sessionId: "api-a1b2",
              url: "https://github.com/acme/api/pull/7",
              number: 7,
              title: "Review me",
              repo: "acme/api",
              createdAt: "2026-05-11T10:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(readWorkItemLifecycles(dataDir, "api", "pr-watch").get("acme/api#7")).toEqual({
      externalId: "acme/api#7",
      state: "running",
      sessionId: "api-a1b2",
      url: "https://github.com/acme/api/pull/7",
      number: 7,
      title: "Review me",
      repo: "acme/api",
      createdAt: "2026-05-11T10:00:00.000Z",
      autoComplete: true,
    });
  });

  it("deletes lifecycle records", async () => {
    const dataDir = await newDataDir();
    recordWorkItemLifecycle(dataDir, "api", "pr-watch", {
      externalId: "acme/api#7",
      state: "running",
      sessionId: "api-a1b2",
      url: "https://github.com/acme/api/pull/7",
      number: 7,
      title: "Review me",
      repo: "acme/api",
      createdAt: "2026-05-11T10:00:00.000Z",
      autoComplete: true,
    });

    deleteWorkItemLifecycle(dataDir, "api", "pr-watch", "acme/api#7");

    expect(readWorkItemLifecycles(dataDir, "api", "pr-watch").size).toBe(0);
  });
});

describe("telegram source state", () => {
  it("removes bindings and reply targets for one session", async () => {
    const dataDir = await newDataDir();
    writeTelegramBindings(
      dataDir,
      "api",
      "telegram-a",
      [
        { chatId: 1, sessionId: "api-1" },
        { chatId: 2, sessionId: "api-2" },
      ],
      { lastUpdateId: 55 },
    );
    writeTelegramBindings(dataDir, "api", "telegram-b", [{ chatId: 3, sessionId: "api-1" }]);
    writeTelegramReplyTarget(dataDir, {
      sessionId: "api-1",
      projectId: "api",
      sourceId: "telegram-a",
      chatId: 1,
    });

    deleteTelegramSourceStateForSession(dataDir, "api", "api-1");

    expect([...readTelegramBindings(dataDir, "api", "telegram-a").values()]).toEqual([
      { chatId: 2, sessionId: "api-2" },
    ]);
    expect(readTelegramBindings(dataDir, "api", "telegram-b").size).toBe(0);
    expect(readTelegramLastUpdateId(dataDir, "api", "telegram-a")).toBe(55);
    expect(readTelegramReplyTarget(dataDir, "api-1")).toBeNull();
  });
});

function reviewPendingBatch(overrides: Partial<PersistedPendingBatch> = {}): PersistedPendingBatch {
  return {
    queueKey: "api:send:api-1",
    projectId: "api",
    triggerId: "send",
    sourceId: "pr-watch",
    batch: {
      kind: "review",
      providerId: "github",
      projectId: "api",
      sourceId: "pr-watch",
      sessionId: "api-1",
      prNumber: 42,
      prTitle: "Tighten coverage",
      signals: [{ key: "merge_conflict", kind: "merge_conflict", text: "Conflicts" }],
    },
    ...overrides,
  };
}

function servicePendingBatch(
  overrides: Partial<PersistedPendingBatch> = {},
): PersistedPendingBatch {
  return {
    queueKey: "api:notify:api-1",
    projectId: "api",
    triggerId: "notify",
    sourceId: "web-watch",
    batch: {
      kind: "service",
      sessionId: "api-1",
      serviceId: "web",
      ruleIds: ["crash"],
    },
    ...overrides,
  };
}

function telegramPendingBatch(
  overrides: Partial<PersistedPendingBatch> = {},
): PersistedPendingBatch {
  return {
    queueKey: "api:notify:api-1",
    projectId: "api",
    triggerId: "notify",
    sourceId: "telegram-a",
    batch: {
      kind: "telegram",
      sessionId: "api-1",
      messages: [
        {
          sessionId: "api-1",
          chatId: 1,
          userId: 123,
          username: "alek",
          messageId: 10,
          text: "hello agent",
        },
      ],
    },
    ...overrides,
  };
}

describe("pending send batches", () => {
  it("returns an empty map when the file is missing", async () => {
    const dataDir = await newDataDir();
    expect(readPendingSendBatches(dataDir).size).toBe(0);
  });

  it("returns an empty map when the file is corrupt", async () => {
    const dataDir = await newDataDir();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "pending-send-batches.json"), "{ not json", "utf8");
    expect(readPendingSendBatches(dataDir).size).toBe(0);
  });

  it("skips records with an invalid shape", async () => {
    const dataDir = await newDataDir();
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "pending-send-batches.json"),
      JSON.stringify({
        records: [
          { queueKey: "api:send:api-1" },
          { ...reviewPendingBatch(), batch: { kind: "unknown" } },
          reviewPendingBatch({ queueKey: "api:send:api-2" }),
        ],
      }),
      "utf8",
    );
    const records = readPendingSendBatches(dataDir);
    expect(records.size).toBe(1);
    expect(records.has("api:send:api-2")).toBe(true);
  });

  it("round-trips a review batch record", async () => {
    const dataDir = await newDataDir();
    const record = reviewPendingBatch();
    recordPendingSendBatch(dataDir, record);
    expect(readPendingSendBatches(dataDir).get(record.queueKey)).toEqual(record);
  });

  it("round-trips a service batch record", async () => {
    const dataDir = await newDataDir();
    const record = servicePendingBatch();
    recordPendingSendBatch(dataDir, record);
    expect(readPendingSendBatches(dataDir).get(record.queueKey)).toEqual(record);
  });

  it("round-trips a telegram batch record", async () => {
    const dataDir = await newDataDir();
    const record = telegramPendingBatch();
    recordPendingSendBatch(dataDir, record);
    expect(readPendingSendBatches(dataDir).get(record.queueKey)).toEqual(record);
  });

  it("overwrites an existing record with the same queueKey", async () => {
    const dataDir = await newDataDir();
    const record = reviewPendingBatch();
    recordPendingSendBatch(dataDir, record);
    const updated = reviewPendingBatch({
      batch: { ...record.batch, prTitle: "Updated title" } as PersistedPendingBatch["batch"],
    });
    recordPendingSendBatch(dataDir, updated);
    const stored = readPendingSendBatches(dataDir);
    expect(stored.size).toBe(1);
    expect(stored.get(record.queueKey)).toEqual(updated);
  });

  it("deletes a stored record", async () => {
    const dataDir = await newDataDir();
    const record = reviewPendingBatch();
    recordPendingSendBatch(dataDir, record);
    deletePendingSendBatch(dataDir, record.queueKey);
    expect(readPendingSendBatches(dataDir).size).toBe(0);
  });

  it("is a no-op when deleting a missing queueKey", async () => {
    const dataDir = await newDataDir();
    const record = reviewPendingBatch();
    recordPendingSendBatch(dataDir, record);
    deletePendingSendBatch(dataDir, "does-not-exist");
    expect(readPendingSendBatches(dataDir).size).toBe(1);
  });
});

describe("session workspaceId normalization", () => {
  const legacyBase = {
    project: "api",
    agent: "claude" as const,
    prompt: "ship it",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    launchCommand: "claude",
    status: "running" as const,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  };

  it("survives a write/read round-trip", async () => {
    // Guards the whitelist trap: normalizeSessionRecord drops any field it
    // does not list, and its own default would then silently re-derive
    // workspaceId, hiding the loss behind a plausible value.
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...legacyBase,
      id: "api-2",
      workspaceId: "api-1",
      tmuxSession: "api-2",
    });

    expect(readSession(dataDir, "api-2")?.workspaceId).toBe("api-1");
  });

  it("derives it from the legacy deskId of a record written before the field existed", async () => {
    const dataDir = await newDataDir();
    const legacy = { ...legacyBase, id: "api-2", deskId: "api-1", tmuxSession: "api-2" };
    writeSession(dataDir, legacy as SessionRecord);

    expect(readSession(dataDir, "api-2")?.workspaceId).toBe("api-1");
  });

  it("falls back to the session's own id for a legacy record with neither field", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...legacyBase, id: "api-1", tmuxSession: "api-1" } as SessionRecord);

    expect(readSession(dataDir, "api-1")?.workspaceId).toBe("api-1");
  });

  it("prefers workspaceId over a stale legacy deskId", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...legacyBase,
      id: "api-2",
      workspaceId: "api-9",
      deskId: "api-1",
      tmuxSession: "api-2",
    });

    expect(readSession(dataDir, "api-2")?.workspaceId).toBe("api-9");
  });
});

describe("staleSidecars", () => {
  const base = {
    project: "api",
    agent: "claude" as const,
    prompt: "ship it",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    launchCommand: "claude",
    status: "stopped" as const,
    stopReason: "stale_timeout" as const,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  };

  it("survives a write/read round-trip alongside stopReason: stale_timeout", async () => {
    // Guards the whitelist trap: normalizeSessionRecord drops any optional
    // field it does not explicitly list, silently, with no error — the same
    // trap workspaceId and sidecarProcs above pin.
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      staleSidecars: ["proxy", "dev"],
    });

    const read = readSession(dataDir, "api-1");
    expect(read?.stopReason).toBe("stale_timeout");
    expect(read?.staleSidecars).toEqual(["proxy", "dev"]);
  });

  it("omits the field entirely for a record that never had it", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...base, id: "api-1", tmuxSession: "api-1" });

    expect(readSession(dataDir, "api-1")).not.toHaveProperty("staleSidecars");
  });
});

describe("todoNudgeDisabled", () => {
  const base = {
    project: "api",
    agent: "claude" as const,
    prompt: "ship it",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    tmuxSession: "api-1",
    launchCommand: "claude",
    status: "running" as const,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  };

  it("survives a write/read round-trip", async () => {
    // Guards the whitelist trap: normalizeSessionRecord drops any optional
    // field it does not explicitly list, silently, with no error.
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...base,
      id: "api-1",
      todoNudgeDisabled: {
        kind: "ledger_corrupt",
        reason: "Event contains an invalid transition",
        atMs: 1,
      },
    });

    expect(readSession(dataDir, "api-1")?.todoNudgeDisabled).toEqual({
      kind: "ledger_corrupt",
      reason: "Event contains an invalid transition",
      atMs: 1,
    });
  });

  it("omits the field entirely for a record that never had it", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...base, id: "api-1" });

    expect(readSession(dataDir, "api-1")).not.toHaveProperty("todoNudgeDisabled");
  });
});

describe("sidecarProcs", () => {
  const base = {
    project: "api",
    agent: "claude" as const,
    prompt: "ship it",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    launchCommand: "claude",
    status: "running" as const,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  };

  it("keeps a valid entry across a write/read round-trip", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      sidecarProcs: { dev: { pid: 1234, pgid: 1234, starttime: 5678 } },
    });

    expect(readSession(dataDir, "api-1")?.sidecarProcs).toEqual({
      dev: { pid: 1234, pgid: 1234, starttime: 5678 },
    });
  });

  it("drops a malformed entry instead of persisting it", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      sidecarProcs: {
        dev: { pid: 1234, pgid: 1234, starttime: 5678 },
        broken: { pid: -1, pgid: 0, starttime: NaN } as unknown as {
          pid: number;
          pgid: number;
          starttime: number;
        },
      },
    });

    expect(readSession(dataDir, "api-1")?.sidecarProcs).toEqual({
      dev: { pid: 1234, pgid: 1234, starttime: 5678 },
    });
  });

  it("stays absent on a record written without the field", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...base, id: "api-1", tmuxSession: "api-1" });

    expect(readSession(dataDir, "api-1")?.sidecarProcs).toBeUndefined();
  });

  it("drops a null entry instead of throwing on read (hand-edited/corrupted JSON)", async () => {
    // writeSession's own normalizeSessionRecord would filter this out before
    // it ever hits disk, so a bad entry can only originate from a file
    // written outside that path — write raw JSON directly to simulate it.
    const dataDir = await newDataDir();
    const sessionDir = join(dataDir, "sessions", "api");
    const sessionPath = join(sessionDir, "api-1.json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...base,
        id: "api-1",
        tmuxSession: "api-1",
        sidecarProcs: {
          dev: { pid: 1234, pgid: 1234, starttime: 5678 },
          broken: null,
        },
      })}\n`,
    );

    expect(() => readSession(dataDir, "api-1")).not.toThrow();
    expect(readSession(dataDir, "api-1")?.sidecarProcs).toEqual({
      dev: { pid: 1234, pgid: 1234, starttime: 5678 },
    });
  });
});

describe("agentSessionId", () => {
  it("keeps agentSessionId across a write/read round-trip", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      project: "api",
      agent: "codex",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "codex",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      id: "api-1",
      tmuxSession: "api-1",
      agentSessionId: "native-session-1",
    });

    expect(readSession(dataDir, "api-1")?.agentSessionId).toBe("native-session-1");
  });
});

describe("session metadata PR migration", () => {
  it("repairs the session index after a fallback scan", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      workspaceId: "api-1",
      agent: "claude",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);
    writeFileSync(
      join(dataDir, "sessions", ".index.json"),
      JSON.stringify({ "api-1": "sessions/missing/api-1.json" }, null, 2),
      "utf8",
    );

    expect(readSession(dataDir, "api-1")).toEqual(expect.objectContaining({ id: "api-1" }));
    expect(JSON.parse(readFileSync(join(dataDir, "sessions", ".index.json"), "utf-8"))).toEqual({
      "api-1": "sessions/api/api-1.json",
    });
  });

  it("persists a native session.pr binding when reading a legacy GitHub pr slot", async () => {
    const dataDir = await newDataDir();
    const sessionDir = join(dataDir, "sessions", "api");
    const sessionPath = join(sessionDir, "api-a1b2.json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify(
        {
          id: "api-a1b2",
          project: "api",
          agent: "claude",
          prompt: "fix the bug",
          branch: "feature/native-pr-binding",
          worktree: true,
          worktreePath: "/tmp/spur-worktrees/api-a1b2",
          tmuxSession: "api-a1b2",
          launchCommand: "claude",
          status: "running",
          createdAt: "2026-04-26T09:00:00.000Z",
          updatedAt: "2026-04-26T09:00:00.000Z",
          slots: {
            title: "Investigate CI",
            links: [
              { label: "tracker", url: "https://tracker.example.com/TASK-9" },
              { label: "pr", url: "https://github.com/acme/api/pull/42" },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(readSession(dataDir, "api-a1b2")).toMatchObject({
      pr: {
        number: 42,
        repo: "acme/api",
        url: "https://github.com/acme/api/pull/42",
      },
      slots: {
        title: "Investigate CI",
        links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
      },
    });

    expect(JSON.parse(readFileSync(sessionPath, "utf-8"))).toMatchObject({
      pr: {
        number: 42,
        repo: "acme/api",
        url: "https://github.com/acme/api/pull/42",
      },
      slots: {
        title: "Investigate CI",
        links: [{ label: "tracker", url: "https://tracker.example.com/TASK-9" }],
      },
    });
  });

  it("does not rewrite non-GitHub pr links into native bindings", async () => {
    const dataDir = await newDataDir();
    const sessionDir = join(dataDir, "sessions", "api");
    const sessionPath = join(sessionDir, "api-a1b2.json");
    mkdirSync(sessionDir, { recursive: true });
    const original = {
      id: "api-a1b2",
      project: "api",
      agent: "claude",
      prompt: "fix the bug",
      branch: "feature/native-pr-binding",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api-a1b2",
      tmuxSession: "api-a1b2",
      launchCommand: "claude",
      status: "running",
      createdAt: "2026-04-26T09:00:00.000Z",
      updatedAt: "2026-04-26T09:00:00.000Z",
      slots: {
        links: [{ label: "pr", url: "https://example.com/review/42" }],
      },
    };
    writeFileSync(sessionPath, `${JSON.stringify(original, null, 2)}\n`);

    const session = readSession(dataDir, "api-a1b2");
    expect(session?.pr).toBeUndefined();
    expect(session?.slots).toEqual(original.slots);

    expect(JSON.parse(readFileSync(sessionPath, "utf-8"))).toEqual(original);
  });

  it("rewrites legacy github-pr GitLab links into generic pr slots", async () => {
    const dataDir = await newDataDir();
    const sessionDir = join(dataDir, "sessions", "api");
    const sessionPath = join(sessionDir, "api-a1b2.json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify(
        {
          id: "api-a1b2",
          project: "api",
          agent: "claude",
          prompt: "fix the bug",
          branch: "feature/native-pr-binding",
          worktree: true,
          worktreePath: "/tmp/spur-worktrees/api-a1b2",
          tmuxSession: "api-a1b2",
          launchCommand: "claude",
          status: "running",
          createdAt: "2026-04-26T09:00:00.000Z",
          updatedAt: "2026-04-26T09:00:00.000Z",
          slots: {
            links: [{ label: "github-pr", url: "https://gitlab.com/acme/api/-/merge_requests/42" }],
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(readSession(dataDir, "api-a1b2")).toMatchObject({
      slots: {
        links: [{ label: "pr", url: "https://gitlab.com/acme/api/-/merge_requests/42" }],
      },
    });

    expect(JSON.parse(readFileSync(sessionPath, "utf-8"))).toMatchObject({
      slots: {
        links: [{ label: "pr", url: "https://gitlab.com/acme/api/-/merge_requests/42" }],
      },
    });
  });

  it("preserves planMode and selfDestruct when writing and reading a session record", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "cursor",
      planMode: true,
      selfDestruct: {
        enabled: true,
        conditions: "tests pass",
      },
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "agent --force --sandbox disabled --plan",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(
      expect.objectContaining({
        planMode: true,
        selfDestruct: {
          enabled: true,
          conditions: "tests pass",
        },
      }),
    );
  });

  it("preserves mode when writing and reading a session record", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      mode: "council",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(expect.objectContaining({ mode: "council" }));
  });

  it("preserves wake state when writing, reading, and listing session records", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      scheduledWake: {
        dueAt: "2026-03-18T10:06:00.000Z",
        message: "Check once",
      },
      intervalWake: {
        nextDueAt: "2026-03-18T10:06:00.000Z",
        intervalMs: 300_000,
        message: "Check CI",
        stopCondition: "CI is green",
      },
      dailyWake: {
        dailyAt: ["09:30", "17:45"],
        nextDueAt: "2026-03-19T09:30:00.000Z",
        message: "Check daily state",
        stopCondition: "Daily checks done",
      },
    };

    writeSession(dataDir, session);

    const rawSession = JSON.parse(
      readFileSync(join(dataDir, "sessions", "api", "api-1.json"), "utf-8"),
    );
    expect(rawSession).toEqual(
      expect.objectContaining({
        scheduledWake: session.scheduledWake,
        intervalWake: session.intervalWake,
        dailyWake: session.dailyWake,
      }),
    );
    expect(readSession(dataDir, "api-1")).toEqual(
      expect.objectContaining({
        scheduledWake: session.scheduledWake,
        intervalWake: session.intervalWake,
        dailyWake: session.dailyWake,
      }),
    );
    expect(listSessions(dataDir)).toEqual([
      expect.objectContaining({
        scheduledWake: session.scheduledWake,
        intervalWake: session.intervalWake,
        dailyWake: session.dailyWake,
      }),
    ]);
  });

  it("preserves claudeAccountId when writing, reading, and listing session records", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude",
      status: "running",
      claudeAccountId: "acc-2",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    const rawSession = JSON.parse(
      readFileSync(join(dataDir, "sessions", "api", "api-1.json"), "utf-8"),
    );
    expect(rawSession).toEqual(expect.objectContaining({ claudeAccountId: "acc-2" }));
    expect(readSession(dataDir, "api-1")).toEqual(
      expect.objectContaining({ claudeAccountId: "acc-2" }),
    );
    expect(listSessions(dataDir)).toEqual([expect.objectContaining({ claudeAccountId: "acc-2" })]);
  });

  it("preserves restrictWrites when writing and reading a session record", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      restrictWrites: true,
      prompt: "review only",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(
      expect.objectContaining({ restrictWrites: true }),
    );
  });

  it("preserves allowedTriggers when writing and reading a session record", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      allowedTriggers: [],
      prompt: "review only",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(expect.objectContaining({ allowedTriggers: [] }));
  });

  it("preserves serverErrorAt when writing and reading a session record", async () => {
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      serverErrorAt: "2026-03-18T10:05:00.000Z",
      prompt: "review only",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(
      expect.objectContaining({ serverErrorAt: "2026-03-18T10:05:00.000Z" }),
    );
    expect(listSessions(dataDir)).toEqual([
      expect.objectContaining({ serverErrorAt: "2026-03-18T10:05:00.000Z" }),
    ]);
  });

  it("preserves model and originalTaskPrompt when writing and reading a session record", async () => {
    // normalizeSessionRecord rebuilds the record field by field, so an
    // optional SessionRecord field missing from its whitelist is silently
    // dropped on the very next write — spawn persists both of these and every
    // later write (a state transition, markOpened) would erase them.
    const dataDir = await newDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "claude",
      model: "opus",
      prompt: "ship it (with orchestrator preamble)",
      originalTaskPrompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(
      expect.objectContaining({ model: "opus", originalTaskPrompt: "ship it" }),
    );
    expect(listSessions(dataDir)).toEqual([
      expect.objectContaining({ model: "opus", originalTaskPrompt: "ship it" }),
    ]);
  });
});

const sessionBase = {
  project: "api",
  agent: "claude" as const,
  prompt: "ship it",
  branch: "api-1",
  worktree: true,
  worktreePath: "/tmp/spur-worktrees/api/api-1",
  launchCommand: "claude",
  status: "completed" as const,
  createdAt: "2026-03-18T10:00:00.000Z",
  updatedAt: "2026-03-18T10:01:00.000Z",
};

describe("archiveSessions", () => {
  it("moves a member's record and log shard out of listSessions/readSession/.index.json in one rewrite", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...sessionBase, id: "api-1", tmuxSession: "api-1" });
    appendEventLog(dataDir, {
      event: "session.test",
      level: "info",
      sessionId: "api-1",
      message: "hello",
    });
    const shardDir = join(dataDir, "sessions", "api-1");
    expect(existsSync(shardDir)).toBe(true);

    const result = archiveSessions(dataDir, [{ id: "api-1", project: "api" }]);

    expect(result.archivedIds).toEqual(["api-1"]);
    expect(readSession(dataDir, "api-1")).toBeNull();
    expect(listSessions(dataDir)).toEqual([]);
    expect(existsSync(shardDir)).toBe(false);
    expect(existsSync(join(result.archiveDir, "api", "api-1", "events.jsonl"))).toBe(true);
    const index = JSON.parse(
      readFileSync(join(dataDir, "sessions", ".index.json"), "utf-8"),
    ) as Record<string, string>;
    expect(index["api-1"]).toBeUndefined();
  });

  it("restores an archived record by moving the file back", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...sessionBase, id: "api-1", tmuxSession: "api-1" });
    const { archiveDir } = archiveSessions(dataDir, [{ id: "api-1", project: "api" }]);
    expect(readSession(dataDir, "api-1")).toBeNull();

    mkdirSync(join(dataDir, "sessions", "api"), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(
      join(archiveDir, "api", "api-1.json"),
      join(dataDir, "sessions", "api", "api-1.json"),
    );

    expect(readSession(dataDir, "api-1")?.id).toBe("api-1");
    expect(listSessions(dataDir).map((s) => s.id)).toEqual(["api-1"]);
  });

  it("archives every member of a group and leaves other records untouched", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...sessionBase, id: "api-1", tmuxSession: "api-1" });
    writeSession(dataDir, { ...sessionBase, id: "api-2", tmuxSession: "api-2" });
    writeSession(dataDir, { ...sessionBase, id: "api-3", tmuxSession: "api-3" });

    archiveSessions(dataDir, [
      { id: "api-1", project: "api" },
      { id: "api-2", project: "api" },
    ]);

    expect(
      listSessions(dataDir)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["api-3"]);
    expect(readSession(dataDir, "api-3")?.id).toBe("api-3");
  });
});

describe("listSessions concurrency", () => {
  it("skips a record file removed mid-scan", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, { ...sessionBase, id: "api-1", tmuxSession: "api-1" });
    const path = join(dataDir, "sessions", "api", "api-1.json");
    const { rmSync } = await import("node:fs");
    rmSync(path);

    expect(listSessions(dataDir)).toEqual([]);
  });

  it("still throws on a corrupt record file", async () => {
    const dataDir = await newDataDir();
    const dir = join(dataDir, "sessions", "api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api-1.json"), "{not json", "utf-8");

    expect(() => listSessions(dataDir)).toThrow(/Invalid session metadata JSON/);
  });
});

describe("listSessions record cache", () => {
  function fixtureSession(id: string): SessionRecord {
    return {
      id,
      project: "api",
      agent: "claude",
      prompt: "ship it",
      branch: id,
      worktree: true,
      worktreePath: `/tmp/spur-worktrees/api/${id}`,
      tmuxSession: id,
      launchCommand: "claude",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };
  }

  it("keeps record identity for unchanged session files", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, fixtureSession("api-1"));
    writeSession(dataDir, fixtureSession("api-2"));

    const first = listSessions(dataDir);
    const second = listSessions(dataDir);
    expect(second.find((s) => s.id === "api-1")).toBe(first.find((s) => s.id === "api-1"));
    expect(second.find((s) => s.id === "api-2")).toBe(first.find((s) => s.id === "api-2"));

    // After a write to only one record, that record is a new object and the
    // untouched one is still the same object reference.
    writeSession(dataDir, { ...fixtureSession("api-1"), status: "completed" });
    const third = listSessions(dataDir);
    const thirdApi1 = third.find((s) => s.id === "api-1");
    const thirdApi2 = third.find((s) => s.id === "api-2");
    expect(thirdApi1).not.toBe(second.find((s) => s.id === "api-1"));
    expect(thirdApi1?.status).toBe("completed");
    expect(thirdApi2).toBe(second.find((s) => s.id === "api-2"));
  });

  it("settles after the legacy pr-slot rewrite", async () => {
    const dataDir = await createTempDir("spur-metadata-cache-");
    tempDirs.push(dataDir);
    const sessionDir = join(dataDir, "sessions", "api");
    const sessionPath = join(sessionDir, "api-a1b2.json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify(
        {
          id: "api-a1b2",
          project: "api",
          agent: "claude",
          prompt: "fix the bug",
          branch: "feature/native-pr-binding",
          worktree: true,
          worktreePath: "/tmp/spur-worktrees/api-a1b2",
          tmuxSession: "api-a1b2",
          launchCommand: "claude",
          status: "running",
          createdAt: "2026-04-26T09:00:00.000Z",
          updatedAt: "2026-04-26T09:00:00.000Z",
          slots: {
            links: [{ label: "pr", url: "https://github.com/acme/api/pull/42" }],
          },
        },
        null,
        2,
      )}\n`,
    );

    // 1st call reads the legacy shape, which readSessionFile rewrites in
    // place — a renameSync always yields a new inode, so this call's cache
    // entry (keyed on the PRE-read, now-stale fingerprint) is invalidated
    // the instant the next call's pre-read stat misses it.
    const first = listSessions(dataDir).find((s) => s.id === "api-a1b2");
    expect(first?.pr).toMatchObject({ number: 42, repo: "acme/api" });

    // 2nd call's pre-read stat misses the stale cache entry, so it
    // re-parses once — reading the now-native shape, with no further
    // rewrite, so this time the fingerprint it caches matches going
    // forward.
    const second = listSessions(dataDir).find((s) => s.id === "api-a1b2");
    expect(second).not.toBe(first);

    // 3rd call is a pure cache hit: same object as the 2nd call, proving no
    // permanent re-parse loop.
    const third = listSessions(dataDir).find((s) => s.id === "api-a1b2");
    expect(third).toBe(second);
  });

  it("does not prune a sibling data dir whose sessions root is a raw string-prefix match", async () => {
    const dataDir1 = await newDataDir();
    // dataDir2's sessions root ("<rootDir1>-extra/sessions") shares
    // dataDir1's sessions root as a raw string prefix with no separator
    // immediately after -- the exact shape of a "sessions-old" vs
    // "sessions" sibling collision.
    const dataDir2 = `${join(dataDir1, "sessions")}-extra`;
    tempDirs.push(dataDir2);

    writeSession(dataDir1, fixtureSession("api-1"));
    writeSession(dataDir2, fixtureSession("other-1"));

    const dataDir2First = listSessions(dataDir2).find((s) => s.id === "other-1");

    // Populating/pruning dataDir1's cache must never evict dataDir2's
    // cache entries just because dataDir2's root string-starts-with
    // dataDir1's root.
    listSessions(dataDir1);

    const dataDir2Second = listSessions(dataDir2).find((s) => s.id === "other-1");
    expect(dataDir2Second).toBe(dataDir2First);
  });

  it("prunes only the missing sessions root before it is restored", async () => {
    const dataDir1 = await newDataDir();
    const dataDir2 = `${join(dataDir1, "sessions")}-extra`;
    tempDirs.push(dataDir2);

    writeSession(dataDir1, fixtureSession("api-1"));
    writeSession(dataDir2, fixtureSession("other-1"));

    const dataDir1First = listSessions(dataDir1).find((s) => s.id === "api-1");
    const dataDir2First = listSessions(dataDir2).find((s) => s.id === "other-1");
    const sessionsRoot = join(dataDir1, "sessions");
    const parkedRoot = join(dataDir1, "sessions-parked");

    // Moving the root away and back preserves the file's fingerprint. A
    // stale cache entry would therefore return the exact same object after
    // restoration unless the missing-root listing prunes it.
    renameSync(sessionsRoot, parkedRoot);
    expect(listSessions(dataDir1)).toEqual([]);
    renameSync(parkedRoot, sessionsRoot);

    const dataDir1Second = listSessions(dataDir1).find((s) => s.id === "api-1");
    const dataDir2Second = listSessions(dataDir2).find((s) => s.id === "other-1");
    expect(dataDir1Second).not.toBe(dataDir1First);
    expect(dataDir2Second).toBe(dataDir2First);
  });

  it("lists a session file that has no index entry", async () => {
    const dataDir = await newDataDir();
    const sessionDir = join(dataDir, "sessions", "api");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "api-1.json"),
      `${JSON.stringify(fixtureSession("api-1"), null, 2)}\n`,
    );

    expect(listSessions(dataDir).map((s) => s.id)).toEqual(["api-1"]);
    expect(readSession(dataDir, "api-1")?.id).toBe("api-1");
  });
});
