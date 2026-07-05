import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deletePendingSendBatch,
  deleteWorkItemLifecycle,
  listSessions,
  readCommentSeenRegistry,
  readPendingSendBatches,
  readWorkItemLifecycles,
  readSession,
  readWorkItemRegistry,
  recordCommentSeen,
  recordPendingSendBatch,
  recordWorkItem,
  recordWorkItemLifecycle,
  writeSession,
} from "../../src/metadata.js";
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

describe("session metadata PR migration", () => {
  it("repairs the session index after a fallback scan", async () => {
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
    const dataDir = await createTempDir("spur-metadata-test-");
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
    const dataDir = await createTempDir("spur-metadata-test-");
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
    const dataDir = await createTempDir("spur-metadata-test-");
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
});
