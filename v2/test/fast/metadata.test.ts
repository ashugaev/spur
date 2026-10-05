import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveSessions,
  deletePendingSendBatch,
  deletePendingSendBatchConditional,
  deleteTelegramSourceStateForSession,
  deleteWorkItemLifecycle,
  hasPendingTelegramSend,
  listSessions,
  clearGitHubPollDisabledSession,
  listGitHubPollDisabledEntries,
  listGitHubPollDisabledSourceIds,
  markGitHubPollDisabledChecked,
  readCommentSeenRegistry,
  readGitHubPollDisabled,
  recordGitHubPollDisabledSession,
  writeGitHubPollDisabled,
  readPendingSendBatches,
  readPendingSendBatch,
  readReviewSourceSnapshot,
  writeReviewSourceSnapshot,
  readTelegramBindings,
  readTelegramLastUpdateId,
  readTelegramChoices,
  readTelegramReplyTarget,
  readWorkItemLifecycles,
  readSession,
  readWorkItemRegistry,
  recordCommentSeen,
  recordPendingSendBatch,
  recordWorkItem,
  recordWorkItemLifecycle,
  findTelegramChoice,
  findTelegramMessageSession,
  recordTelegramMessages,
  takeTelegramChoice,
  writeTelegramOffer,
  writeTelegramBindings,
  writeTelegramReplyTarget,
  writeSession,
  updatePendingSendBatchConditional,
} from "../../src/metadata.js";
import { appendEventLog } from "../../src/event-log.js";
import type {
  PersistedPendingBatch,
  SessionRecord,
  SubmitAckBaseline,
  TelegramChoice,
} from "../../src/types.js";
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
  it("round-trips confirmed conflict clear IDs and rejects malformed IDs", async () => {
    const dataDir = await newDataDir();
    const snapshot = {
      prNumber: 42,
      signals: new Map(),
      mergeConflictClearId: "12345678-1234-1234-1234-123456789012",
    };
    writeReviewSourceSnapshot(dataDir, "github", "api", "pr-watch", "api-1", snapshot);
    expect(readReviewSourceSnapshot(dataDir, "github", "api", "pr-watch", "api-1")).toEqual(
      snapshot,
    );
    writeReviewSourceSnapshot(dataDir, "github", "api", "pr-watch", "api-1", {
      ...snapshot,
      mergeConflictClearId: "bad",
    });
    expect(() => readReviewSourceSnapshot(dataDir, "github", "api", "pr-watch", "api-1")).toThrow(
      "Invalid merge-conflict clear identifier",
    );
  });
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

describe("github poll-disabled registry", () => {
  it("returns an empty map when the registry file is missing", async () => {
    const dataDir = await newDataDir();
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.size).toBe(0);
  });

  it("returns an empty map when the registry file is corrupt", async () => {
    const dataDir = await newDataDir();
    const dir = join(dataDir, "source-state", "github-poll-disabled", "api");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pr-watch.json"), "{ not json", "utf8");
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.size).toBe(0);
  });

  it("drops non-numeric and non-integer values", async () => {
    const dataDir = await newDataDir();
    const dir = join(dataDir, "source-state", "github-poll-disabled", "api");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "pr-watch.json"),
      JSON.stringify({ "api-a1b2": 42, "api-c3d4": "42", "api-e5f6": 42.5, "api-g7h8": -1 }),
      "utf8",
    );
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.size).toBe(1);
    expect(entries.get("api-a1b2")).toEqual({ prNumber: 42, disabledAtMs: 0, lastCheckedAtMs: 0 });
  });

  // A9: a legacy bare-number entry (the shape this branch wrote before the
  // recheck window landed) is honored and probes immediately.
  it("reads a legacy numeric poll-disabled entry as a zero-timestamp entry", async () => {
    const dataDir = await newDataDir();
    const dir = join(dataDir, "source-state", "github-poll-disabled", "api");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pr-watch.json"), JSON.stringify({ "api-a1b2": 42 }), "utf8");
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.get("api-a1b2")).toEqual({ prNumber: 42, disabledAtMs: 0, lastCheckedAtMs: 0 });
  });

  it("round-trips a recorded session", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 1000);
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.get("api-a1b2")).toEqual({
      prNumber: 42,
      disabledAtMs: 1000,
      lastCheckedAtMs: 1000,
    });
  });

  it("preserves disabledAtMs and lastCheckedAtMs when re-recording the same prNumber", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 1000);
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 9999);
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.get("api-a1b2")).toEqual({
      prNumber: 42,
      disabledAtMs: 1000,
      lastCheckedAtMs: 1000,
    });
  });

  it("an empty map removes the registry file", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 1000);
    writeGitHubPollDisabled(dataDir, "api", "pr-watch", new Map());
    const path = join(dataDir, "source-state", "github-poll-disabled", "api", "pr-watch.json");
    expect(existsSync(path)).toBe(false);
  });

  it("clear returns the prNumber then null on repeat", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 1000);
    expect(clearGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2")).toBe(42);
    expect(clearGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2")).toBeNull();
  });

  // A7 half: markGitHubPollDisabledChecked returns false and writes nothing for an
  // unknown session, so the caller's override keeps gating instead of dropping the
  // disable entirely.
  it("markGitHubPollDisabledChecked returns false and writes nothing for an unknown session", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "source-state", "github-poll-disabled", "api", "pr-watch.json");
    expect(markGitHubPollDisabledChecked(dataDir, "api", "pr-watch", "api-a1b2", 5000)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("markGitHubPollDisabledChecked stamps lastCheckedAtMs and preserves disabledAtMs", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 1000);
    expect(markGitHubPollDisabledChecked(dataDir, "api", "pr-watch", "api-a1b2", 5000)).toBe(true);
    const entries = readGitHubPollDisabled(dataDir, "api", "pr-watch");
    expect(entries.get("api-a1b2")).toEqual({
      prNumber: 42,
      disabledAtMs: 1000,
      lastCheckedAtMs: 5000,
    });
  });

  it("listGitHubPollDisabledSourceIds lists every registry file under a project", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42, 1000);
    recordGitHubPollDisabledSession(dataDir, "api", "gone-source", "api-a1b2", 43, 1000);
    recordGitHubPollDisabledSession(dataDir, "web", "other", "web-1", 44, 1000);
    expect(listGitHubPollDisabledSourceIds(dataDir, "api").sort()).toEqual([
      "gone-source",
      "pr-watch",
    ]);
    expect(listGitHubPollDisabledSourceIds(dataDir, "missing")).toEqual([]);
  });

  it("listGitHubPollDisabledEntries walks every project/source and sorts by disabledAtMs", async () => {
    const dataDir = await newDataDir();
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-b", 7, 2000);
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a", 8, 1000);
    recordGitHubPollDisabledSession(dataDir, "web", "issues", "web-c", 9, 3000);
    const entries = listGitHubPollDisabledEntries(dataDir);
    expect(entries).toEqual([
      {
        projectId: "api",
        sourceId: "pr-watch",
        sessionId: "api-a",
        prNumber: 8,
        disabledAtMs: 1000,
      },
      {
        projectId: "api",
        sourceId: "pr-watch",
        sessionId: "api-b",
        prNumber: 7,
        disabledAtMs: 2000,
      },
      { projectId: "web", sourceId: "issues", sessionId: "web-c", prNumber: 9, disabledAtMs: 3000 },
    ]);
  });

  it("listGitHubPollDisabledEntries returns an empty array when the root is missing", async () => {
    const dataDir = await newDataDir();
    expect(listGitHubPollDisabledEntries(dataDir)).toEqual([]);
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

    expect(deleteTelegramSourceStateForSession(dataDir, "api", "api-1")).toEqual({
      heldBinding: true,
    });

    expect([...readTelegramBindings(dataDir, "api", "telegram-a").values()]).toEqual([
      { chatId: 2, sessionId: "api-2" },
    ]);
    expect(readTelegramBindings(dataDir, "api", "telegram-b").size).toBe(0);
    expect(readTelegramLastUpdateId(dataDir, "api", "telegram-a")).toBe(55);
    expect(readTelegramReplyTarget(dataDir, "api-1")).toBeNull();
    expect(deleteTelegramSourceStateForSession(dataDir, "api", "api-1")).toEqual({
      heldBinding: false,
    });
  });

  it("records telegram message owners per source, upserts, and evicts the oldest past 1000", async () => {
    const dataDir = await newDataDir();
    recordTelegramMessages(dataDir, "api", "tg", { sessionId: "api-1", chatId: 5 }, [1, 2]);
    recordTelegramMessages(dataDir, "api", "tg", { sessionId: "api-2", chatId: 5 }, [2]);
    recordTelegramMessages(dataDir, "api", "tg", { sessionId: "api-2", chatId: 5 }, []);

    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 1)).toBe("api-1");
    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 2)).toBe("api-2");
    expect(findTelegramMessageSession(dataDir, "api", "other", 5, 1)).toBeNull();

    const ids = Array.from({ length: 1000 }, (_, index) => 100 + index);
    recordTelegramMessages(dataDir, "api", "tg", { sessionId: "api-3", chatId: 5 }, ids);

    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 1)).toBeNull();
    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 100)).toBe("api-3");
    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 1099)).toBe("api-3");
  });

  it("finds a message owner only in its own chat", async () => {
    const dataDir = await newDataDir();
    recordTelegramMessages(dataDir, "api", "tg", { sessionId: "api-1", chatId: 5 }, [7]);

    expect(findTelegramMessageSession(dataDir, "api", "tg", 6, 7)).toBeNull();
    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 7)).toBe("api-1");
  });

  it("treats a corrupt telegram message file as empty", async () => {
    const dataDir = await newDataDir();
    recordTelegramMessages(dataDir, "api", "tg", { sessionId: "api-1", chatId: 5 }, [7]);
    writeFileSync(join(dataDir, "source-state", "telegram", "api", "messages", "tg.json"), "{");

    expect(findTelegramMessageSession(dataDir, "api", "tg", 5, 7)).toBeNull();
  });

  it("finds a pending choice without consuming it", async () => {
    const dataDir = await newDataDir();
    writeTelegramOffer(dataDir, "api", "tg", offerOf([choice({ token: "t1" })]));

    expect(findTelegramChoice(dataDir, "api", "tg", "t1", 999)).toBeNull();
    expect(findTelegramChoice(dataDir, "api", "tg", "t1", -1001)).toMatchObject({ token: "t1" });
    expect(readTelegramChoices(dataDir, "api", "tg")).toHaveLength(1);
  });

  it("consumes the whole offer on the first taken choice", async () => {
    const dataDir = await newDataDir();
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([
        choice({ token: "t1", offerId: "offer-1", value: "yes" }),
        choice({ token: "t2", offerId: "offer-1", value: "no" }),
        choice({ token: "t3", offerId: "offer-2", value: "later" }),
      ]),
    );

    // A click from a chat the offer was not sent to consumes nothing.
    expect(takeTelegramChoice(dataDir, "api", "tg", "t1", 999)).toBeNull();
    expect(readTelegramChoices(dataDir, "api", "tg")).toHaveLength(3);

    expect(takeTelegramChoice(dataDir, "api", "tg", "t1", -1001)).toMatchObject({ value: "yes" });

    expect(readTelegramChoices(dataDir, "api", "tg").map((entry) => entry.token)).toEqual(["t3"]);
    expect(takeTelegramChoice(dataDir, "api", "tg", "t2", -1001)).toBeNull();
  });

  it("retires the session's previous offer in the same chat", async () => {
    const dataDir = await newDataDir();
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([
        choice({ token: "old-a", offerId: "offer-1" }),
        choice({ token: "old-b", offerId: "offer-1" }),
      ]),
    );
    // Another session's offer in the same chat is untouched.
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([choice({ token: "other", offerId: "offer-other", sessionId: "api-2" })]),
    );
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([choice({ token: "new-a", offerId: "offer-2" })]),
    );

    expect(readTelegramChoices(dataDir, "api", "tg").map((entry) => entry.token)).toEqual([
      "other",
      "new-a",
    ]);
    expect(takeTelegramChoice(dataDir, "api", "tg", "old-a", -1001)).toBeNull();
  });

  it("retires the pending offer when a reply carries no buttons", async () => {
    const dataDir = await newDataDir();
    writeTelegramOffer(dataDir, "api", "tg", offerOf([choice({ token: "t1" })]));

    writeTelegramOffer(dataDir, "api", "tg", offerOf([]));

    expect(readTelegramChoices(dataDir, "api", "tg")).toHaveLength(0);
  });

  it("drops expired choices and caps the store", async () => {
    const dataDir = await newDataDir();
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([
        choice({ token: "stale", expiresAt: new Date(Date.now() - 1_000).toISOString() }),
        choice({ token: "fresh" }),
      ]),
    );

    expect(readTelegramChoices(dataDir, "api", "tg").map((entry) => entry.token)).toEqual([
      "fresh",
    ]);
    expect(takeTelegramChoice(dataDir, "api", "tg", "stale", -1001)).toBeNull();

    // One offer per session, so the cap is only reachable across sessions.
    for (let index = 0; index < 199; index += 1) {
      writeTelegramOffer(
        dataDir,
        "api",
        "tg",
        offerOf([
          choice({ token: `t${index}`, offerId: `offer-${index}`, sessionId: `bulk-${index}` }),
        ]),
      );
    }
    // 199 singles + a 3-button offer crosses the 200 cap; the young offer must
    // survive intact, so whole old offers go instead of a partial slice.
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf(
        ["a", "b", "c"].map((suffix) =>
          choice({ token: `last-${suffix}`, offerId: "offer-last", sessionId: "api-last" }),
        ),
      ),
    );
    const stored = readTelegramChoices(dataDir, "api", "tg");
    expect(stored.length).toBeLessThanOrEqual(200);
    expect(stored.filter((entry) => entry.offerId === "offer-last")).toHaveLength(3);
    expect(stored.some((entry) => entry.token === "fresh")).toBe(false);
    expect(stored.some((entry) => entry.token === "t0")).toBe(false);
    expect(stored.some((entry) => entry.token === "t198")).toBe(true);
  });

  it("removes a session's pending choices with the rest of its telegram state", async () => {
    const dataDir = await newDataDir();
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([choice({ token: "mine", sessionId: "api-1" })]),
    );
    writeTelegramOffer(
      dataDir,
      "api",
      "tg",
      offerOf([choice({ token: "theirs", sessionId: "api-2" })], "api-2"),
    );

    deleteTelegramSourceStateForSession(dataDir, "api", "api-1");

    expect(readTelegramChoices(dataDir, "api", "tg").map((entry) => entry.token)).toEqual([
      "theirs",
    ]);
  });
});

function offerOf(choices: TelegramChoice[], sessionId = "api-1", chatId = -1001) {
  return { sessionId, chatId, choices };
}

function choice(
  overrides: Partial<TelegramChoice> & Pick<TelegramChoice, "token">,
): TelegramChoice {
  return {
    offerId: "offer-1",
    sessionId: "api-1",
    chatId: -1001,
    text: "Yes",
    value: "yes",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

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
  describe("admission cap metadata", () => {
    it("loads legacy records and round-trips a positive finite deadline", async () => {
      const dataDir = await newDataDir();
      const legacy = reviewPendingBatch();
      recordPendingSendBatch(dataDir, legacy);
      expect(readPendingSendBatches(dataDir).get(legacy.queueKey)).toEqual(legacy);
      const held = { ...legacy, admissionCapRetryAt: 1_800_000_000_000 };
      recordPendingSendBatch(dataDir, held);
      expect(readPendingSendBatches(dataDir).get(legacy.queueKey)).toEqual({
        ...held,
        admissionCapDenials: 1,
      });
      for (const admissionCapDenials of [1, 7]) {
        const counted = { ...held, admissionCapDenials };
        recordPendingSendBatch(dataDir, counted);
        expect(readPendingSendBatches(dataDir).get(legacy.queueKey)).toEqual(counted);
        const countOnly = { ...legacy, admissionCapDenials };
        recordPendingSendBatch(dataDir, countOnly);
        expect(readPendingSendBatches(dataDir).get(legacy.queueKey)).toEqual(countOnly);
      }
      const expiredLegacy = { ...legacy, admissionCapRetryAt: 1 };
      recordPendingSendBatch(dataDir, expiredLegacy);
      expect(readPendingSendBatches(dataDir).get(legacy.queueKey)).toEqual({
        ...expiredLegacy,
        admissionCapDenials: 1,
      });
    });

    it.each(["later", null, 0, -1, 1.5, 8, NaN, Infinity, -Infinity])(
      "rejects an invalid serialized denial count %s",
      async (admissionCapDenials) => {
        const dataDir = await newDataDir();
        writeFileSync(
          join(dataDir, "pending-send-batches.json"),
          JSON.stringify({ records: [{ ...reviewPendingBatch(), admissionCapDenials }] }),
        );
        expect(readPendingSendBatches(dataDir).size).toBe(0);
      },
    );

    it.each(["later", null, 0, -1, NaN, Infinity, -Infinity])(
      "rejects an invalid serialized deadline %s",
      async (admissionCapRetryAt) => {
        const dataDir = await newDataDir();
        writeFileSync(
          join(dataDir, "pending-send-batches.json"),
          JSON.stringify({ records: [{ ...reviewPendingBatch(), admissionCapRetryAt }] }),
        );
        expect(readPendingSendBatches(dataDir).size).toBe(0);
      },
    );

    it("clears the deadline only for the owned work revision and claim", async () => {
      const dataDir = await newDataDir();
      const record = reviewPendingBatch({
        workId: "held-work",
        revision: 4,
        admissionCapRetryAt: 1_800_000_000_000,
        admissionCapDenials: 3,
        claim: {
          controllerId: "controller",
          routeLeaseId: "lease",
          claimId: "owned-claim",
          claimedAt: "2026-10-01T00:00:00.000Z",
        },
      });
      recordPendingSendBatch(dataDir, record);
      const cleared = {
        ...record,
        revision: 5,
        admissionCapRetryAt: undefined,
        admissionCapDenials: undefined,
      };
      for (const expected of [
        { workId: "other-work", revision: 4, claimId: "owned-claim" },
        { workId: "held-work", revision: 3, claimId: "owned-claim" },
        { workId: "held-work", revision: 4, claimId: "other-claim" },
      ]) {
        expect(updatePendingSendBatchConditional(dataDir, expected, cleared)).toBe(false);
        expect(readPendingSendBatch(dataDir, "held-work")).toEqual(record);
      }
      expect(
        updatePendingSendBatchConditional(
          dataDir,
          { workId: "held-work", revision: 4, claimId: "owned-claim" },
          cleared,
        ),
      ).toBe(true);
      expect(readPendingSendBatch(dataDir, "held-work")).not.toHaveProperty("admissionCapRetryAt");
      expect(readPendingSendBatch(dataDir, "held-work")).not.toHaveProperty("admissionCapDenials");
    });
  });

  it("round-trips retry tombstones and rejects malformed present accounting", async () => {
    const dataDir = await newDataDir();
    const entry = {
      itemKey: "item",
      fingerprint: "a".repeat(64),
      deliveryAttempts: 8,
      ciAttempts: 0,
      nextAttemptAt: 1234,
    };
    const record = reviewPendingBatch({ retryAccounting: [entry] });
    recordPendingSendBatch(dataDir, record);
    expect(readPendingSendBatches(dataDir).get(record.queueKey)?.retryAccounting).toEqual([entry]);
    for (const invalid of [
      { ...entry, deliveryAttempts: 9 },
      { ...entry, ciAttempts: -1 },
      { ...entry, fingerprint: "bad" },
      { ...entry, nextAttemptAt: "tomorrow" },
    ]) {
      writeFileSync(
        join(dataDir, "pending-send-batches.json"),
        JSON.stringify({ records: [{ ...record, retryAccounting: [invalid] }] }),
      );
      expect(readPendingSendBatches(dataDir).size).toBe(0);
    }
  });
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
    expect(statSync(join(dataDir, "pending-send-batches.json")).mode & 0o777).toBe(0o600);
  });

  it("updates and deletes only the matching work revision and claim", async () => {
    const dataDir = await newDataDir();
    const record = reviewPendingBatch({ workId: "work-1", revision: 3 });
    recordPendingSendBatch(dataDir, record);
    const claimed = {
      ...record,
      revision: 4,
      claim: {
        controllerId: "controller-1",
        routeLeaseId: "lease-1",
        claimId: "claim-1",
        claimedAt: "2026-09-01T00:00:00.000Z",
      },
    };

    expect(
      updatePendingSendBatchConditional(dataDir, { workId: "work-1", revision: 2 }, claimed),
    ).toBe(false);
    expect(
      updatePendingSendBatchConditional(dataDir, { workId: "work-1", revision: 3 }, claimed),
    ).toBe(true);
    expect(readPendingSendBatch(dataDir, "work-1")).toEqual(claimed);
    expect(
      deletePendingSendBatchConditional(dataDir, {
        workId: "work-1",
        revision: 4,
        claimId: "foreign-claim",
      }),
    ).toBe(false);
    expect(
      deletePendingSendBatchConditional(dataDir, {
        workId: "work-1",
        revision: 4,
        claimId: "claim-1",
      }),
    ).toBe(true);
    expect(readPendingSendBatch(dataDir, "work-1")).toBeNull();
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

  it("preserves explicit closeout ownership through a write/read round-trip", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...legacyBase,
      id: "api-2",
      workspaceId: "api-1",
      tmuxSession: "api-2",
      closeoutOwner: true,
    });

    expect(readSession(dataDir, "api-2")?.closeoutOwner).toBe(true);
  });

  it.each([undefined, -1, 0, 3, 4, 1.5, "3"])(
    "validates automatic reminder counters: %s",
    async (attempts) => {
      const dataDir = await newDataDir();
      writeSession(dataDir, {
        ...legacyBase,
        id: "api-2",
        tmuxSession: "api-2",
        serverErrorReactivationAttempts: attempts,
        todoNudge: { fingerprint: "a".repeat(64), attempts },
      } as SessionRecord);
      const restored = readSession(dataDir, "api-2");
      const valid =
        typeof attempts === "number" &&
        Number.isInteger(attempts) &&
        attempts >= 0 &&
        attempts <= 3;
      expect(restored?.serverErrorReactivationAttempts).toBe(valid ? attempts : undefined);
      expect(restored?.todoNudge).toEqual(
        valid ? { fingerprint: "a".repeat(64), attempts } : undefined,
      );
    },
  );

  it("drops a malformed ToDo reminder fingerprint", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...legacyBase,
      id: "api-2",
      tmuxSession: "api-2",
      todoNudge: { fingerprint: "invalid", attempts: 3 },
    });
    expect(readSession(dataDir, "api-2")?.todoNudge).toBeUndefined();
  });

  it.each([
    { name: "exclusive writable worktree", overrides: {}, expected: true },
    { name: "restricted worktree", overrides: { restrictWrites: true }, expected: false },
    { name: "shared checkout", overrides: { worktree: false }, expected: false },
    { name: "reused workspace", overrides: { workspaceId: "api-1" }, expected: false },
    { name: "malformed ownership", overrides: { closeoutOwner: "yes" }, expected: true },
  ])(
    "derives conservative ownership for a legacy $name record",
    async ({ overrides, expected }) => {
      const dataDir = await newDataDir();
      writeSession(dataDir, {
        ...legacyBase,
        ...overrides,
        id: "api-2",
        tmuxSession: "api-2",
      } as SessionRecord);

      expect(readSession(dataDir, "api-2")?.closeoutOwner).toBe(expected);
    },
  );
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

describe("tokenUsage", () => {
  it("persists budget approval through disk reload", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      status: "budget_limited",
      stopReason: "token_budget",
      tokenBudgetOverride: true,
    });
    expect(readSession(dataDir, "api-1")).toMatchObject({
      status: "budget_limited",
      tokenBudgetOverride: true,
    });
  });

  it("normalizes legacy token budget stops to budget_limited", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      stopReason: "token_budget",
    });
    expect(readSession(dataDir, "api-1")?.status).toBe("budget_limited");
  });

  const base = {
    project: "api",
    agent: "claude" as const,
    prompt: "ship it",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    launchCommand: "claude",
    status: "stopped" as const,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  };

  it("survives the session metadata whitelist", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      tokenUsage: {
        provider: "codex",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        generations: {
          "codex:thread": { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        },
      },
    });
    expect(readSession(dataDir, "api-1")?.tokenUsage?.totalTokens).toBe(100);
  });

  it("migrates valid legacy baselines and rejects aggregate overflow", async () => {
    const dataDir = await newDataDir();
    const record = {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      tokenUsage: {
        provider: "claude",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        sources: {
          first: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        },
      },
    } as unknown as SessionRecord;
    writeSession(dataDir, record);
    expect(readSession(dataDir, "api-1")?.tokenUsage?.generations).toEqual({
      first: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      "legacy:claude": { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    });

    writeSession(dataDir, {
      ...record,
      tokenUsage: {
        provider: "claude",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        sources: {
          first: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
          second: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
        },
      },
    } as unknown as SessionRecord);
    expect(readSession(dataDir, "api-1")).not.toHaveProperty("tokenUsage");
  });

  it("preserves complete optional components and rejects subset violations", async () => {
    const dataDir = await newDataDir();
    const record = {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      tokenUsage: {
        provider: "opencode",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 10,
        reasoningOutputTokens: 5,
        generations: {
          generation: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
            cacheReadInputTokens: 30,
            cacheWriteInputTokens: 10,
            reasoningOutputTokens: 5,
          },
        },
      },
    } as unknown as SessionRecord;
    writeSession(dataDir, record);
    expect(readSession(dataDir, "api-1")?.tokenUsage?.reasoningOutputTokens).toBe(5);

    writeSession(dataDir, {
      ...record,
      tokenUsage: {
        ...record.tokenUsage,
        cacheReadInputTokens: 81,
        generations: {
          generation: {
            ...record.tokenUsage?.generations.generation,
            cacheReadInputTokens: 81,
          },
        },
      },
    } as unknown as SessionRecord);
    expect(readSession(dataDir, "api-1")).not.toHaveProperty("tokenUsage");

    writeSession(dataDir, {
      ...record,
      tokenUsage: {
        ...record.tokenUsage,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 40,
        generations: {
          generation: {
            ...record.tokenUsage?.generations.generation,
            cacheReadInputTokens: 50,
            cacheWriteInputTokens: 40,
          },
        },
      },
    } as unknown as SessionRecord);
    expect(readSession(dataDir, "api-1")).not.toHaveProperty("tokenUsage");
  });

  it.each([
    { provider: "codex", inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    {
      provider: "unknown",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      sources: { source: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } },
    },
    {
      provider: "codex",
      inputTokens: "80",
      outputTokens: 20,
      totalTokens: 100,
      sources: { source: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } },
    },
    {
      provider: "codex",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      sources: {},
    },
    {
      provider: "codex",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      sources: { source: { inputTokens: 80, outputTokens: -1, totalTokens: 100 } },
    },
    {
      provider: "codex",
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      sources: { source: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } },
    },
  ])("discards incomplete or invalid persisted token usage %#", async (tokenUsage) => {
    const dataDir = await newDataDir();
    const session = {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      tokenUsage,
    } as unknown as SessionRecord;
    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).not.toHaveProperty("tokenUsage");
  });

  it("round-trips valid pre-flight usage and drops an invalid cache partition", async () => {
    const dataDir = await newDataDir();
    const session = {
      ...base,
      id: "api-1",
      tmuxSession: "api-1",
      preflightTokenUsage: {
        status: "measured",
        attemptCount: 2,
        unknownAttemptCount: 0,
        providerIterationCount: 3,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 10,
        byProvider: {
          claude: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
            cacheReadInputTokens: 30,
            cacheWriteInputTokens: 10,
          },
        },
      },
    } as SessionRecord;
    writeSession(dataDir, session);
    expect(readSession(dataDir, "api-1")?.preflightTokenUsage).toEqual(session.preflightTokenUsage);
    const preflightTokenUsage = session.preflightTokenUsage;
    if (!preflightTokenUsage) throw new Error("missing test pre-flight usage");

    writeSession(dataDir, {
      ...session,
      preflightTokenUsage: {
        ...preflightTokenUsage,
        cacheReadInputTokens: 75,
        cacheWriteInputTokens: 25,
        byProvider: {
          claude: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
            cacheReadInputTokens: 75,
            cacheWriteInputTokens: 25,
          },
        },
      },
    });
    expect(readSession(dataDir, "api-1")).not.toHaveProperty("preflightTokenUsage");
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

describe("agentLaunchId", () => {
  it("keeps agentLaunchId across a write/read round-trip", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      project: "api",
      agent: "claude",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "claude",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      id: "api-1",
      tmuxSession: "api-1",
      agentLaunchId: "launch-generation-1",
    });

    expect(readSession(dataDir, "api-1")?.agentLaunchId).toBe("launch-generation-1");
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

  it("preserves model, explicit reasoning and originalTaskPrompt across later writes", async () => {
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
      reasoningEffort: "high",
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
      expect.objectContaining({
        model: "opus",
        reasoningEffort: "high",
        originalTaskPrompt: "ship it",
      }),
    );
    expect(listSessions(dataDir)).toEqual([
      expect.objectContaining({
        model: "opus",
        reasoningEffort: "high",
        originalTaskPrompt: "ship it",
      }),
    ]);
    const stored = readSession(dataDir, "api-1");
    expect(stored).toBeDefined();
    if (!stored) throw new Error("Missing persisted session");
    writeSession(dataDir, { ...stored, status: "stopped" });
    expect(readSession(dataDir, "api-1")?.reasoningEffort).toBe("high");
    const { reasoningEffort: _effort, ...legacy } = session;
    writeSession(dataDir, legacy);
    expect(readSession(dataDir, "api-1")).not.toHaveProperty("reasoningEffort");
  });

  it("keeps submitUnconfirmedAt across an unrelated later write and drops it once cleared", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      submitUnconfirmedAt: "2026-03-18T10:00:30.000Z",
      submitRequeuedMessage: "typed once",
      submitFailedMessage: { message: "typed twice", at: "2026-03-18T10:01:30.000Z" },
    });
    const first = readSession(dataDir, "api-1");
    if (!first) throw new Error("record missing");
    writeSession(dataDir, { ...first, updatedAt: "2026-03-18T10:02:00.000Z" });

    expect(readSession(dataDir, "api-1")?.submitUnconfirmedAt).toBe("2026-03-18T10:00:30.000Z");
    // The re-queue budget survives a write, and so a restart.
    expect(readSession(dataDir, "api-1")?.submitRequeuedMessage).toBe("typed once");
    expect(readSession(dataDir, "api-1")?.submitFailedMessage).toEqual({
      message: "typed twice",
      at: "2026-03-18T10:01:30.000Z",
    });
    expect(listSessions(dataDir)[0]?.submitUnconfirmedAt).toBe("2026-03-18T10:00:30.000Z");

    const { submitUnconfirmedAt: _cleared, ...confirmed } = first;
    writeSession(dataDir, confirmed);
    expect(readSession(dataDir, "api-1")?.submitUnconfirmedAt).toBeUndefined();
  });

  it("migrates a hold persisted under the old launchUnconfirmedAt name, writing only the new one", async () => {
    const dataDir = await newDataDir();
    const legacy = {
      id: "api-1",
      project: "api",
      agent: "codex" as const,
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex",
      status: "running" as const,
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      launchUnconfirmedAt: "2026-03-18T10:00:30.000Z",
    };
    writeSession(dataDir, legacy as unknown as SessionRecord);

    const migrated = readSession(dataDir, "api-1");
    expect(migrated?.submitUnconfirmedAt).toBe("2026-03-18T10:00:30.000Z");
    expect(migrated).not.toHaveProperty("launchUnconfirmedAt");
    expect(listSessions(dataDir)[0]?.submitUnconfirmedAt).toBe("2026-03-18T10:00:30.000Z");
  });

  it("keeps queuedMessageTyped across an unrelated later write and drops it once cleared", async () => {
    const dataDir = await newDataDir();
    const typed = {
      message: "typed text",
      typedAt: "2026-03-18T10:00:30.000Z",
      ackBaseline: { agent: "codex" as const, offsets: { "/s/rollout.jsonl": 120 } },
    };
    writeSession(dataDir, {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      queuedMessageTyped: typed,
    });
    const first = readSession(dataDir, "api-1");
    if (!first) throw new Error("record missing");
    writeSession(dataDir, { ...first, updatedAt: "2026-03-18T10:02:00.000Z" });

    expect(readSession(dataDir, "api-1")?.queuedMessageTyped).toEqual(typed);
    expect(listSessions(dataDir)[0]?.queuedMessageTyped).toEqual(typed);

    const { queuedMessageTyped: _cleared, ...acked } = first;
    writeSession(dataDir, acked);
    expect(readSession(dataDir, "api-1")?.queuedMessageTyped).toBeUndefined();
  });

  it("keeps every agent's ack baseline shape on the typed marker and drops a malformed one alone", async () => {
    const dataDir = await newDataDir();
    const base = {
      id: "api-1",
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
    const typedAt = "2026-03-18T10:00:30.000Z";
    const baselines: SubmitAckBaseline[] = [
      { agent: "claude", file: "/c.jsonl", size: 7 },
      { agent: "cursor", file: "/k.jsonl", size: 9 },
      { agent: "cursor", file: "/k.jsonl", size: 9, rotated: { file: "/r.jsonl", size: 40 } },
      { agent: "opencode", sessionId: "ses_1", after: { createdMs: 200, id: "msg_2" } },
      { agent: "opencode", sessionId: "ses_1", after: null },
    ];
    for (const ackBaseline of baselines) {
      writeSession(dataDir, {
        ...base,
        queuedMessageTyped: { message: "m", typedAt, ackBaseline },
      });
      expect(readSession(dataDir, "api-1")?.queuedMessageTyped).toEqual({
        message: "m",
        typedAt,
        ackBaseline,
      });
    }
    const malformed = { agent: "claude", size: "x" } as unknown as {
      agent: "claude";
      file: string;
      size: number;
    };
    writeSession(dataDir, {
      ...base,
      queuedMessageTyped: { message: "m", typedAt, ackBaseline: malformed },
    });
    expect(readSession(dataDir, "api-1")?.queuedMessageTyped).toEqual({ message: "m", typedAt });
    // A malformed rotation entry drops alone; the pinned offset survives.
    const badRotation = {
      agent: "cursor",
      file: "/k.jsonl",
      size: 9,
      rotated: { file: 3 },
    } as unknown as SubmitAckBaseline;
    writeSession(dataDir, {
      ...base,
      queuedMessageTyped: { message: "m", typedAt, ackBaseline: badRotation },
    });
    expect(readSession(dataDir, "api-1")?.queuedMessageTyped?.ackBaseline).toEqual({
      agent: "cursor",
      file: "/k.jsonl",
      size: 9,
    });
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

describe("hasPendingTelegramSend", () => {
  const telegramRecord = (
    queueKey: string,
    sessionId: string,
    claimed = false,
  ): PersistedPendingBatch => ({
    queueKey,
    projectId: "api",
    triggerId: "chat",
    sourceId: "tg",
    batch: {
      kind: "telegram",
      sessionId,
      messages: [{ sessionId, chatId: 1, userId: 2, messageId: 3, text: "hi" }],
    },
    ...(claimed
      ? {
          claim: {
            controllerId: "c",
            routeLeaseId: "l",
            claimId: "id",
            claimedAt: "2026-01-01T00:00:00.000Z",
          },
        }
      : {}),
  });

  it("matches only telegram batches for that session", async () => {
    const dataDir = await newDataDir();
    expect(hasPendingTelegramSend(dataDir, "api-1")).toBe(false);
    recordPendingSendBatch(dataDir, {
      queueKey: "api:review:api-1",
      projectId: "api",
      triggerId: "review",
      sourceId: "pr",
      batch: {
        kind: "review",
        providerId: "github",
        projectId: "api",
        sourceId: "pr",
        sessionId: "api-1",
        prNumber: 1,
        prTitle: "t",
        signals: [],
      },
    });
    recordPendingSendBatch(dataDir, telegramRecord("api:chat:api-2", "api-2"));
    expect(hasPendingTelegramSend(dataDir, "api-1")).toBe(false);

    recordPendingSendBatch(dataDir, telegramRecord("api:chat:api-1", "api-1", true));
    expect(hasPendingTelegramSend(dataDir, "api-1")).toBe(true);
    expect(hasPendingTelegramSend(dataDir, "api-1", { unclaimedOnly: true })).toBe(false);
    recordPendingSendBatch(dataDir, telegramRecord("api:chat:api-1", "api-1"));
    expect(hasPendingTelegramSend(dataDir, "api-1", { unclaimedOnly: true })).toBe(true);
  });
});
