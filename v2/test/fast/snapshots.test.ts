import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_MAX_BYTES,
  InvalidSnapshotRequestError,
  SNAPSHOT_REMINDER_PREFIXES,
  SnapshotCorruptError,
  SnapshotTooLargeError,
  firstAgentWorkMs,
  isSpurReminder,
  isSpurToolCommand,
  lastAgentWorkMs,
  listSnapshots,
  parseSnapshotIncludeDone,
  parseSnapshotListQuery,
  readSnapshot,
  snapshotAgeSeconds,
  snapshotRequestMessage,
  snapshotDir,
  snapshotDue,
  snapshotGateBlock,
  snapshotSettings,
  writeSnapshot,
  type SnapshotListQuery,
  type SnapshotWriteContext,
} from "../../src/snapshots.js";
import {
  CLAUDE_SERVER_ERROR_REACTIVATION_PROMPT,
  RATE_LIMIT_REACTIVATION_PROMPT,
} from "../../src/reactivation-prompts.js";
import {
  DEFAULT_DAILY_WAKE_MESSAGE,
  DEFAULT_INTERVAL_WAKE_MESSAGE,
  DEFAULT_WAKE_MESSAGE,
  formatDailyWakeMessage,
  formatIntervalWakeMessage,
} from "../../src/wake-schedule.js";
import type { ProjectConfig, SessionRecord, TranscriptEntry } from "../../src/types.js";
import { countCommitsSince, readWorktreeHead } from "../../src/workspace.js";
import { createTempDir } from "../helpers/common.js";

const session: SessionRecord = {
  id: "snap-1",
  project: "test",
  agent: "claude",
  model: "opus",
  prompt: "p",
  branch: "feature/x",
  worktree: true,
  worktreePath: "/nonexistent",
  tmuxSession: "snap-1",
  launchCommand: "claude",
  status: "running",
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
};

function context(overrides: Partial<SnapshotWriteContext> = {}): SnapshotWriteContext {
  return {
    maxBytes: DEFAULT_SNAPSHOT_MAX_BYTES,
    branch: "feature/x",
    headSha: "abc123",
    dirty: false,
    todoRevision: "rev-1",
    links: [{ label: "PR", url: "https://example.test/1" }],
    ...overrides,
  };
}

const ASC: SnapshotListQuery = { order: "asc" };

async function dataDir(): Promise<string> {
  const dir = await createTempDir("spur-snapshots-");
  await mkdir(join(dir, "sessions", session.id), { recursive: true });
  return dir;
}

describe("snapshot store", () => {
  it("writes contiguous ascending versions with full content", async () => {
    const dir = await dataDir();
    const content = "# Now\nline é\n".repeat(50);
    for (const text of [content, "two", "three"]) {
      writeSnapshot(dir, session, { content: text, final: false }, context());
    }
    expect(listSnapshots(dir, session, "live", ASC).map((meta) => meta.version)).toEqual([1, 2, 3]);
    expect(listSnapshots(dir, session, "live", ASC)[0]).not.toHaveProperty("content");
    const first = readSnapshot(dir, session, 1, "live");
    expect(first).toMatchObject({
      version: 1,
      sessionId: "snap-1",
      project: "test",
      agent: "claude",
      model: "opus",
      branch: "feature/x",
      headSha: "abc123",
      dirty: false,
      todoRevision: "rev-1",
      trigger: "manual",
      final: false,
      links: [{ label: "PR", url: "https://example.test/1" }],
      content,
    });
    expect(readSnapshot(dir, session, "latest", "live")?.content).toBe("three");
    expect(readSnapshot(dir, session, 9, "live")).toBeUndefined();
  });

  it("marks final writes with the final trigger", async () => {
    const dir = await dataDir();
    const meta = writeSnapshot(dir, session, { content: "x", final: true }, context());
    expect(meta).toMatchObject({ final: true, trigger: "final" });
  });

  it("returns undefined for latest when no snapshot exists", async () => {
    const dir = await dataDir();
    expect(readSnapshot(dir, session, "latest", "live")).toBeUndefined();
    expect(listSnapshots(dir, session, "live", ASC)).toEqual([]);
  });

  it("ignores tmp residue and numbers the next version correctly", async () => {
    const dir = await dataDir();
    writeSnapshot(dir, session, { content: "one", final: false }, context());
    const snaps = snapshotDir(dir, session.id, session.project);
    await writeFile(join(snaps, ".2.json.tmp.1.dead"), "{partial");
    await writeFile(join(snaps, "notes.txt"), "x");
    expect(listSnapshots(dir, session, "live", ASC).map((meta) => meta.version)).toEqual([1]);
    expect(writeSnapshot(dir, session, { content: "two", final: false }, context()).version).toBe(
      2,
    );
  });

  it("refuses over-limit content naming both numbers and stores nothing", async () => {
    const dir = await dataDir();
    const write = () =>
      writeSnapshot(dir, session, { content: "ééé", final: false }, context({ maxBytes: 5 }));
    expect(write).toThrow(SnapshotTooLargeError);
    expect(write).toThrow(
      "Snapshot is 6 bytes; limit is 5 bytes (projects.test.snapshots.maxBytes).",
    );
    expect(listSnapshots(dir, session, "live", ASC)).toEqual([]);
  });

  it("fails closed on a corrupt version", async () => {
    const dir = await dataDir();
    writeSnapshot(dir, session, { content: "one", final: true }, context());
    const snaps = snapshotDir(dir, session.id, session.project);
    await writeFile(join(snaps, "2.json"), "{not json");
    expect(() => listSnapshots(dir, session, "live", ASC)).toThrow(SnapshotCorruptError);
    expect(() => readSnapshot(dir, session, "latest", "live")).toThrow(SnapshotCorruptError);
    expect(() => snapshotGateBlock(dir, session, "rev-1", "final")).toThrow(SnapshotCorruptError);
    const good = JSON.parse(await readFile(join(snaps, "1.json"), "utf8")) as object;
    await writeFile(join(snaps, "2.json"), JSON.stringify({ ...good, version: 7 }));
    expect(() => readSnapshot(dir, session, 2, "live")).toThrow(SnapshotCorruptError);
  });

  it("reads archived snapshots", async () => {
    const dir = await createTempDir("spur-snapshots-arch-");
    const archived = join(dir, "sessions-archive", "test", session.id, "snapshots");
    await mkdir(archived, { recursive: true });
    const live = await dataDir();
    writeSnapshot(live, session, { content: "kept", final: false }, context());
    await writeFile(
      join(archived, "1.json"),
      await readFile(join(snapshotDir(live, session.id), "1.json")),
    );
    expect(readSnapshot(dir, session, "latest", "archived")?.content).toBe("kept");
    // A live directory recreated empty by logging must not hide the archived versions.
    await mkdir(join(dir, "sessions", session.id), { recursive: true });
    expect(readSnapshot(dir, session, "latest", "live")).toBeUndefined();
    expect(readSnapshot(dir, session, "latest", "archived")?.content).toBe("kept");
    expect(listSnapshots(dir, session, "archived", ASC)).toHaveLength(1);
  });

  describe("list query", () => {
    const versions = async (query: SnapshotListQuery): Promise<number[]> => {
      const dir = await dataDir();
      for (const text of ["a", "b", "c", "d", "e"]) {
        writeSnapshot(dir, session, { content: text, final: false }, context());
      }
      return listSnapshots(dir, session, "live", query).map((meta) => meta.version);
    };

    it("orders and caps", async () => {
      expect(await versions({ order: "asc" })).toEqual([1, 2, 3, 4, 5]);
      expect(await versions({ order: "desc" })).toEqual([5, 4, 3, 2, 1]);
      expect(await versions({ order: "desc", limit: 2 })).toEqual([5, 4]);
      expect(await versions({ order: "asc", limit: 2 })).toEqual([1, 2]);
    });

    it("treats before and after as exclusive bounds, alone or combined", async () => {
      expect(await versions({ order: "desc", before: 4 })).toEqual([3, 2, 1]);
      expect(await versions({ order: "asc", after: 2 })).toEqual([3, 4, 5]);
      expect(await versions({ order: "asc", after: 1, before: 5, limit: 2 })).toEqual([2, 3]);
      expect(await versions({ order: "asc", after: 3, before: 4 })).toEqual([]);
    });

    it("reads only the selected files", async () => {
      const dir = await dataDir();
      for (const text of ["a", "b", "c"]) {
        writeSnapshot(dir, session, { content: text, final: false }, context());
      }
      await writeFile(join(snapshotDir(dir, session.id), "1.json"), "{not json");
      expect(
        listSnapshots(dir, session, "live", { order: "desc", limit: 2 }).map((m) => m.version),
      ).toEqual([3, 2]);
    });
  });
});

describe("snapshot list parameters", () => {
  const parse = (query: string) => parseSnapshotListQuery(new URLSearchParams(query));

  it("defaults to oldest first with no cap", () => {
    expect(parse("")).toEqual({ order: "asc" });
  });

  it("reads order, limit, before and after", () => {
    expect(parse("order=desc&limit=100&before=7&after=2")).toEqual({
      order: "desc",
      limit: 100,
      before: 7,
      after: 2,
    });
  });

  it.each([
    "order=newest",
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=x",
    "before=0",
    "before=-1",
    "after=abc",
    "limit=1&limit=2",
    "before=1&before=2",
    "order=asc&order=desc",
  ])("rejects %s", (query) => {
    expect(() => parse(query)).toThrow(InvalidSnapshotRequestError);
  });

  it("accepts includeDone=1 only", () => {
    expect(parseSnapshotIncludeDone(new URLSearchParams(""))).toBe(false);
    expect(parseSnapshotIncludeDone(new URLSearchParams("includeDone=1"))).toBe(true);
    expect(() => parseSnapshotIncludeDone(new URLSearchParams("includeDone=true"))).toThrow(
      InvalidSnapshotRequestError,
    );
  });
});

describe("snapshotAgeSeconds", () => {
  it("floors and never goes negative", () => {
    const at = "2026-10-15T00:00:00.000Z";
    const atMs = Date.parse(at);
    expect(snapshotAgeSeconds(at, atMs + 90_999)).toBe(90);
    expect(snapshotAgeSeconds(at, atMs - 5_000)).toBe(0);
  });
});

describe("snapshot gate", () => {
  async function seeded(...entries: Array<{ revision: string; final: boolean }>) {
    const dir = await dataDir();
    for (const entry of entries) {
      writeSnapshot(
        dir,
        session,
        { content: "x", final: entry.final },
        context({ todoRevision: entry.revision }),
      );
    }
    return dir;
  }

  it("blocks with no snapshot", async () => {
    const dir = await seeded();
    expect(snapshotGateBlock(dir, session, "rev-1", "any")).toBe(true);
  });

  it("any passes for a current non-final snapshot, final does not", async () => {
    const dir = await seeded({ revision: "rev-1", final: false });
    expect(snapshotGateBlock(dir, session, "rev-1", "any")).toBe(false);
    expect(snapshotGateBlock(dir, session, "rev-1", "final")).toBe(true);
  });

  it("final passes when a final snapshot exists for the current revision", async () => {
    const dir = await seeded(
      { revision: "rev-1", final: true },
      { revision: "rev-1", final: false },
    );
    expect(snapshotGateBlock(dir, session, "rev-1", "final")).toBe(false);
  });

  it("stops scanning at an older revision", async () => {
    const dir = await seeded({ revision: "rev-1", final: true });
    expect(snapshotGateBlock(dir, session, "rev-2", "final")).toBe(true);
    expect(snapshotGateBlock(dir, session, "rev-2", "any")).toBe(true);
  });
});

describe("snapshotSettings", () => {
  it("applies defaults for an unconfigured project", () => {
    const defaults = { enabled: true, maxBytes: 32768, requireFinal: false, freshnessMinutes: 30 };
    expect(snapshotSettings(undefined)).toEqual(defaults);
    expect(snapshotSettings({} as ProjectConfig)).toEqual(defaults);
  });

  it("leaves the final-snapshot gate off when only enabled is false", () => {
    expect(snapshotSettings({ snapshots: { enabled: false } } as ProjectConfig)).toMatchObject({
      enabled: false,
      requireFinal: false,
    });
  });

  it("uses configured values", () => {
    expect(
      snapshotSettings({
        snapshots: { enabled: false, maxBytes: 100, requireFinal: false, freshnessMinutes: 15 },
      } as ProjectConfig),
    ).toEqual({ enabled: false, maxBytes: 100, requireFinal: false, freshnessMinutes: 15 });
  });
});

describe("snapshotDue", () => {
  const latestAt = "2026-01-01T00:00:00.000Z";
  const created = "2025-12-31T00:00:00.000Z";
  const base = Date.parse(latestAt);
  const freshnessMs = 10 * 60_000;

  it("is never due without an activity signal", () => {
    expect(
      snapshotDue({ latestAt, sessionCreatedAt: created, activityAt: null, freshnessMs }),
    ).toBe(false);
  });

  it("is not due when activity stays within freshness of the latest snapshot", () => {
    const activityAt = new Date(base + freshnessMs);
    expect(snapshotDue({ latestAt, sessionCreatedAt: created, activityAt, freshnessMs })).toBe(
      false,
    );
  });

  it("is due when activity runs past freshness after the latest snapshot", () => {
    const activityAt = new Date(base + freshnessMs + 1);
    expect(snapshotDue({ latestAt, sessionCreatedAt: created, activityAt, freshnessMs })).toBe(
      true,
    );
  });

  it("uses session creation when no snapshot exists", () => {
    const activityAt = new Date(Date.parse(created) + freshnessMs + 1);
    expect(
      snapshotDue({ latestAt: null, sessionCreatedAt: created, activityAt, freshnessMs }),
    ).toBe(true);
  });
});

describe("snapshotRequestMessage", () => {
  it("pins the snapshot request text around the given command", () => {
    const message = snapshotRequestMessage("'/data/session-tools/s1/spur-snapshot'");
    expect(message).toBe(
      "Spur snapshot is stale: work moved on since your latest snapshot. Write one now with '/data/session-tools/s1/spur-snapshot' write --file <path> (--file - reads stdin), then continue.",
    );
    expect(isSpurReminder(message)).toBe(true);
  });
});

describe("isSpurReminder", () => {
  it.each(SNAPSHOT_REMINDER_PREFIXES)("matches %s", (prefix) => {
    expect(isSpurReminder(`  ${prefix} rest`)).toBe(true);
  });

  it("rejects other text", () => {
    expect(isSpurReminder("please fix the bug")).toBe(false);
  });

  it.each([
    DEFAULT_WAKE_MESSAGE,
    RATE_LIMIT_REACTIVATION_PROMPT,
    CLAUDE_SERVER_ERROR_REACTIVATION_PROMPT,
  ])("matches the Spur-owned prompt %s through a listed prefix", (message) => {
    expect(SNAPSHOT_REMINDER_PREFIXES).toContain(message);
    expect(isSpurReminder(message)).toBe(true);
  });

  it("matches formatted interval and daily wakes with the default body only", () => {
    expect(
      isSpurReminder(formatIntervalWakeMessage("s1", DEFAULT_INTERVAL_WAKE_MESSAGE, "CI\ngreen")),
    ).toBe(true);
    expect(
      isSpurReminder(formatDailyWakeMessage("s1", DEFAULT_DAILY_WAKE_MESSAGE, "CI green")),
    ).toBe(true);
    expect(isSpurReminder(formatIntervalWakeMessage("s1", "Check the deploy", "CI green"))).toBe(
      false,
    );
    expect(isSpurReminder(formatDailyWakeMessage("s1", "Check the deploy", "CI green"))).toBe(
      false,
    );
    expect(isSpurReminder(DEFAULT_INTERVAL_WAKE_MESSAGE)).toBe(false);
  });
});

describe("isSpurToolCommand", () => {
  it.each([
    '"$SPUR_TODO_COMMAND" list',
    "'/d/session-tools/x/spur-snapshot' write --file a",
    "git status && spur-todo hold 1",
    '"$SPUR_SESSION_TOOL_DIR"/spur-slots show',
  ])("matches %s", (command) => {
    expect(isSpurToolCommand(command)).toBe(true);
  });

  it.each(["git status", "npm test"])("rejects %s", (command) => {
    expect(isSpurToolCommand(command)).toBe(false);
  });
});

describe("lastAgentWorkMs", () => {
  const floorMs = 1_000_000;
  const untimedActivityMs = 9_999_999;
  const at = (offset: number) => floorMs + offset;
  const run = (entries: TranscriptEntry[], atStart = true) =>
    lastAgentWorkMs(entries, { untimedActivityMs, floorMs, atStart });
  const user = (text: string, timestampMs?: number): TranscriptEntry => ({
    kind: "message",
    role: "user",
    text,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  });
  const assistant = (timestampMs?: number): TranscriptEntry => ({
    kind: "message",
    role: "assistant",
    text: "reply",
    ...(timestampMs === undefined ? {} : { timestampMs }),
  });
  const tool = (timestampMs: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
    ({ kind: "tool", name: "Bash", timestampMs, ...extra }) as TranscriptEntry;
  const reminder = "Spur ToDo still has open work:\n- a";

  it("finds no work when everything sits at or below the floor", () => {
    expect(run([user("go", at(-5)), assistant(at(-4)), tool(at(0))])).toEqual({
      workMs: null,
      complete: true,
    });
  });

  it("ignores Spur-only tools and reply text in a reminder turn", () => {
    const entries = [
      user("go", at(-10)),
      user(reminder, at(5)),
      tool(at(6), { spurCall: true }),
      tool(at(7), { inputSummary: '{"cmd":"spur-todo list"}' }),
      assistant(at(300)),
    ];
    expect(run(entries)).toEqual({ workMs: null, complete: true });
  });

  it("counts a non-Spur tool in a reminder turn", () => {
    const entries = [user(reminder, at(5)), tool(at(6), { name: "Edit" }), assistant(at(8))];
    expect(run(entries)).toEqual({ workMs: at(6), complete: true });
    expect(
      run([user(reminder, at(5)), tool(at(6), { inputSummary: '{"cmd":"npm test"}' })]),
    ).toEqual({ workMs: at(6), complete: true });
  });

  it("does not count a command mixing work with a Spur call", () => {
    const mixed = [user(reminder, at(5)), tool(at(6), { spurCall: true })];
    expect(run(mixed)).toEqual({ workMs: null, complete: true });
    expect(isSpurToolCommand("npm test && spur-todo list")).toBe(true);
  });

  it("counts reply text of a non-reminder turn", () => {
    expect(run([user("do it", at(5)), assistant(at(9))])).toEqual({
      workMs: at(9),
      complete: true,
    });
  });

  it("asks for a full read when the slice ends mid-turn with only text pending", () => {
    expect(run([assistant(at(9))], false)).toEqual({ workMs: null, complete: false });
  });

  it("reports complete null when nothing is pending at the floor", () => {
    expect(run([assistant(at(-3)), tool(at(0))], false)).toEqual({ workMs: null, complete: true });
  });

  it("asks for a full read when an untimed slice has no opener, and counts it only at the start", () => {
    const untimedSpurCall: TranscriptEntry = { kind: "tool", name: "Bash", spurCall: true };
    const replies = [assistant(), assistant(), untimedSpurCall];
    expect(run(replies, false)).toEqual({ workMs: null, complete: false });
    expect(run(replies, true)).toEqual({ workMs: untimedActivityMs, complete: true });
  });

  it("drops text above the floor when its reminder opener sits below it", () => {
    expect(run([user(reminder, at(-10)), assistant(at(20))])).toEqual({
      workMs: null,
      complete: true,
    });
  });

  it("counts text above the floor when its non-reminder opener sits below it", () => {
    expect(run([user("go", at(-10)), assistant(at(20))])).toEqual({
      workMs: at(20),
      complete: true,
    });
  });

  it("counts a non-Spur tool above the floor without seeing the opener", () => {
    expect(run([assistant(at(8)), tool(at(9))], false)).toEqual({ workMs: at(9), complete: true });
  });

  it("treats entries before the first user message as a non-reminder turn at the start", () => {
    expect(run([assistant(at(9))], true)).toEqual({ workMs: at(9), complete: true });
  });

  it("uses the activity instant for an untimed newest non-reminder turn", () => {
    expect(run([user("go"), assistant()])).toEqual({ workMs: untimedActivityMs, complete: true });
  });

  it("counts nothing for an untimed newest reminder turn", () => {
    expect(run([user("go"), assistant(), user(reminder), assistant()])).toEqual({
      workMs: null,
      complete: true,
    });
  });
});

describe("readWorktreeHead", () => {
  it("reads branch, sha and dirty state from a real repo", async () => {
    const repo = await createTempDir("spur-head-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-b", "main");
    git("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    const clean = await readWorktreeHead(repo);
    expect(clean).toMatchObject({ branch: "main", dirty: false });
    expect(clean.headSha).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(repo, "new.txt"), "x");
    expect((await readWorktreeHead(repo)).dirty).toBe(true);
  });

  it("returns nulls for a missing or blank path", async () => {
    const empty = { branch: null, headSha: null, dirty: null };
    expect(await readWorktreeHead("/nonexistent/path")).toEqual(empty);
    expect(await readWorktreeHead("")).toEqual(empty);
  });
});

describe("firstAgentWorkMs", () => {
  const floorMs = 1_000_000;
  const at = (offset: number) => floorMs + offset;
  const run = (entries: TranscriptEntry[], atStart = true) =>
    firstAgentWorkMs(entries, { floorMs, atStart });
  const user = (text: string, timestampMs?: number): TranscriptEntry => ({
    kind: "message",
    role: "user",
    text,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  });
  const assistant = (timestampMs?: number): TranscriptEntry => ({
    kind: "message",
    role: "assistant",
    text: "reply",
    ...(timestampMs === undefined ? {} : { timestampMs }),
  });
  const tool = (timestampMs: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
    ({ kind: "tool", name: "Bash", timestampMs, ...extra }) as TranscriptEntry;
  const reminder = "Spur ToDo still has open work:\n- a";

  it("returns the first work, not the newest", () => {
    expect(run([user("go", at(-10)), assistant(at(10)), tool(at(2400))])).toEqual({
      workMs: at(10),
      complete: true,
    });
  });

  it("finds no work when everything sits at or below the floor", () => {
    expect(run([user("go", at(-5)), assistant(at(-4)), tool(at(0))])).toEqual({
      workMs: null,
      complete: true,
    });
  });

  it("skips reminder-turn text and Spur tools, then counts the first non-Spur tool", () => {
    const entries = [
      user("go", at(-10)),
      assistant(at(-9)),
      user(reminder, at(5)),
      tool(at(6), { spurCall: true }),
      assistant(at(300)),
      tool(at(480)),
    ];
    expect(run(entries)).toEqual({ workMs: at(480), complete: true });
  });

  it("finds nothing for a reminder turn that only replies", () => {
    expect(
      run([
        user("go", at(-10)),
        user(reminder, at(5)),
        tool(at(6), { spurCall: true }),
        assistant(at(9)),
      ]),
    ).toEqual({ workMs: null, complete: true });
  });

  it("counts Spur tools in a user-started turn", () => {
    expect(run([user("go", at(-10)), tool(at(7), { spurCall: true })])).toEqual({
      workMs: at(7),
      complete: true,
    });
  });

  it("never counts untimed entries", () => {
    expect(run([user("go"), assistant()])).toEqual({ workMs: null, complete: true });
  });

  it("reports an incomplete slice that starts above the floor", () => {
    const entries = [user("go", at(10)), assistant(at(11))];
    expect(run(entries, false)).toEqual({ workMs: null, complete: false });
    expect(run(entries, true)).toEqual({ workMs: at(11), complete: true });
  });

  it("reports an incomplete slice whose first counting entry has no opener", () => {
    expect(run([tool(at(-3)), assistant(at(5))], false)).toEqual({ workMs: null, complete: false });
  });

  it("is complete when an entry at the floor precedes the first work and its opener is in the slice", () => {
    expect(run([user("go", at(-1)), assistant(at(6))], false)).toEqual({
      workMs: at(6),
      complete: true,
    });
  });

  it("matches the full read once the retained window hides the first work", () => {
    const full = [
      user("go", at(-10)),
      assistant(at(5)),
      ...Array.from({ length: 300 }, (_, i) => tool(at(100 + i))),
    ];
    const window = full.slice(-300);
    expect(run(window, false)).toEqual({ workMs: null, complete: false });
    expect(run(full, true)).toEqual({ workMs: at(5), complete: true });
  });
});

describe("countCommitsSince", () => {
  async function repo() {
    const path = await createTempDir("spur-commits-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], {
        cwd: path,
        stdio: "pipe",
      })
        .toString()
        .trim();
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "base");
    return { path, git, head: () => git("rev-parse", "HEAD") };
  }

  it("counts commits on top of the snapshot head on the same branch", async () => {
    const { path, git, head } = await repo();
    const sha = head();
    expect(await countCommitsSince(path, sha, "main")).toBe(0);
    git("commit", "--allow-empty", "-m", "one");
    git("commit", "--allow-empty", "-m", "two");
    expect(await countCommitsSince(path, sha, "main")).toBe(2);
  });

  it("is null after the snapshot commit was amended", async () => {
    const { path, git, head } = await repo();
    const sha = head();
    git("commit", "--allow-empty", "--amend", "-m", "amended");
    expect(await countCommitsSince(path, sha, "main")).toBeNull();
  });

  it("is null after a rebase onto a new base", async () => {
    const { path, git, head } = await repo();
    git("checkout", "-b", "work");
    git("commit", "--allow-empty", "-m", "work 1");
    const sha = head();
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "main moved");
    git("checkout", "work");
    git("rebase", "main");
    expect(await countCommitsSince(path, sha, "work")).toBeNull();
  });

  it("is null after checking out another branch", async () => {
    const { path, git, head } = await repo();
    const sha = head();
    git("checkout", "-b", "other");
    git("commit", "--allow-empty", "-m", "other");
    expect(await countCommitsSince(path, sha, "main")).toBeNull();
  });

  it("is null for a missing worktree, blank path, or unrecorded head or branch", async () => {
    const { path, head } = await repo();
    const sha = head();
    expect(await countCommitsSince("/nonexistent/path", sha, "main")).toBeNull();
    expect(await countCommitsSince("", sha, "main")).toBeNull();
    expect(await countCommitsSince(path, null, "main")).toBeNull();
    expect(await countCommitsSince(path, sha, null)).toBeNull();
    expect(await countCommitsSince(path, "0".repeat(40), "main")).toBeNull();
  });
});
