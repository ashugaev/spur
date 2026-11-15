import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_MAX_BYTES,
  SNAPSHOT_REQUEST_MESSAGE,
  SnapshotCorruptError,
  SnapshotTooLargeError,
  listSnapshots,
  readSnapshot,
  snapshotDir,
  snapshotDue,
  snapshotGateBlock,
  snapshotSettings,
  writeSnapshot,
  type SnapshotWriteContext,
} from "../../src/snapshots.js";
import type { ProjectConfig, SessionRecord } from "../../src/types.js";
import { readWorktreeHead } from "../../src/workspace.js";
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
    expect(listSnapshots(dir, session).map((meta) => meta.version)).toEqual([1, 2, 3]);
    expect(listSnapshots(dir, session)[0]).not.toHaveProperty("content");
    const first = readSnapshot(dir, session, 1);
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
    expect(readSnapshot(dir, session, "latest")?.content).toBe("three");
    expect(readSnapshot(dir, session, 9)).toBeUndefined();
  });

  it("marks final writes with the final trigger", async () => {
    const dir = await dataDir();
    const meta = writeSnapshot(dir, session, { content: "x", final: true }, context());
    expect(meta).toMatchObject({ final: true, trigger: "final" });
  });

  it("returns undefined for latest when no snapshot exists", async () => {
    const dir = await dataDir();
    expect(readSnapshot(dir, session, "latest")).toBeUndefined();
    expect(listSnapshots(dir, session)).toEqual([]);
  });

  it("ignores tmp residue and numbers the next version correctly", async () => {
    const dir = await dataDir();
    writeSnapshot(dir, session, { content: "one", final: false }, context());
    const snaps = snapshotDir(dir, session.id, session.project);
    await writeFile(join(snaps, ".2.json.tmp.1.dead"), "{partial");
    await writeFile(join(snaps, "notes.txt"), "x");
    expect(listSnapshots(dir, session).map((meta) => meta.version)).toEqual([1]);
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
    expect(listSnapshots(dir, session)).toEqual([]);
  });

  it("fails closed on a corrupt version", async () => {
    const dir = await dataDir();
    writeSnapshot(dir, session, { content: "one", final: true }, context());
    const snaps = snapshotDir(dir, session.id, session.project);
    await writeFile(join(snaps, "2.json"), "{not json");
    expect(() => listSnapshots(dir, session)).toThrow(SnapshotCorruptError);
    expect(() => readSnapshot(dir, session, "latest")).toThrow(SnapshotCorruptError);
    expect(() => snapshotGateBlock(dir, session, "rev-1", "final")).toThrow(SnapshotCorruptError);
    const good = JSON.parse(await readFile(join(snaps, "1.json"), "utf8")) as object;
    await writeFile(join(snaps, "2.json"), JSON.stringify({ ...good, version: 7 }));
    expect(() => readSnapshot(dir, session, 2)).toThrow(SnapshotCorruptError);
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
    expect(readSnapshot(dir, session, "latest")?.content).toBe("kept");
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
    const defaults = { maxBytes: 32768, requireFinal: false, freshnessMinutes: 10 };
    expect(snapshotSettings(undefined)).toEqual(defaults);
    expect(snapshotSettings({} as ProjectConfig)).toEqual(defaults);
  });

  it("uses configured values", () => {
    expect(
      snapshotSettings({
        snapshots: { maxBytes: 100, requireFinal: true, freshnessMinutes: 15 },
      } as ProjectConfig),
    ).toEqual({ maxBytes: 100, requireFinal: true, freshnessMinutes: 15 });
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

describe("SNAPSHOT_REQUEST_MESSAGE", () => {
  it("pins the snapshot request text", () => {
    expect(SNAPSHOT_REQUEST_MESSAGE).toBe(
      'Spur snapshot is stale: work moved on since your latest snapshot. Write one now with "$SPUR_SNAPSHOT_COMMAND" write --file <path> (--file - reads stdin), then continue.',
    );
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
