import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as NodeFs from "node:fs";

const linkState = vi.hoisted(() => ({
  failWith: undefined as string | undefined,
  shortWrite: false,
  zeroWrite: false,
  zeroCalls: 0,
  links: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    writeSync: (fd: number, data: Uint8Array, offset: number) => {
      if (linkState.zeroWrite) {
        // A sync loop cannot be interrupted by a test timeout; cap retries instead.
        linkState.zeroCalls += 1;
        if (linkState.zeroCalls > 100) throw new Error("writeSync retried without progress");
        return 0;
      }
      if (!linkState.shortWrite) return actual.writeSync(fd, data, offset);
      const error = new Error("disk full") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      if (offset > 0) throw error;
      return actual.writeSync(fd, data, 0, 1);
    },
    linkSync: (existing: string, target: string) => {
      linkState.links += 1;
      if (linkState.failWith) {
        const error = new Error("link failed") as NodeJS.ErrnoException;
        error.code = linkState.failWith;
        throw error;
      }
      actual.linkSync(existing, target);
    },
  };
});

const { SnapshotConflictError, snapshotDir, writeSnapshot } =
  await import("../../src/snapshots.js");
const { createTempDir } = await import("../helpers/common.js");

const session = {
  id: "snap-2",
  project: "test",
  agent: "claude" as const,
  prompt: "p",
  branch: "b",
  worktree: true,
  worktreePath: "/x",
  tmuxSession: "snap-2",
  launchCommand: "claude",
  status: "running" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
};

const context = {
  maxBytes: 1000,
  branch: null,
  headSha: null,
  dirty: null,
  todoRevision: "",
  links: [],
};

describe("snapshot link failures", () => {
  it("maps EEXIST to a conflict, keeps the existing version and leaves no tmp", async () => {
    const dir = await createTempDir("spur-snapshots-link-");
    await mkdir(join(dir, "sessions", session.id), { recursive: true });
    const snaps = snapshotDir(dir, session.id, session.project);
    linkState.failWith = undefined;
    writeSnapshot(dir, session, { content: "one", final: false }, context);
    const before = await readFile(join(snaps, "1.json"), "utf8");
    linkState.failWith = "EEXIST";
    expect(() => writeSnapshot(dir, session, { content: "two", final: false }, context)).toThrow(
      SnapshotConflictError,
    );
    linkState.failWith = "EIO";
    expect(() => writeSnapshot(dir, session, { content: "two", final: false }, context)).toThrow(
      "link failed",
    );
    linkState.failWith = undefined;
    expect(await readFile(join(snaps, "1.json"), "utf8")).toBe(before);
    expect(await readdir(snaps)).toEqual(["1.json"]);
  });

  it("completes a short write or fails before linking, never publishing truncated JSON", async () => {
    const dir = await createTempDir("spur-snapshots-short-");
    await mkdir(join(dir, "sessions", session.id), { recursive: true });
    const snaps = snapshotDir(dir, session.id, session.project);
    linkState.failWith = undefined;
    linkState.shortWrite = true;
    linkState.links = 0;
    expect(() => writeSnapshot(dir, session, { content: "one", final: false }, context)).toThrow(
      "disk full",
    );
    linkState.shortWrite = false;
    expect(linkState.links).toBe(0);
    expect(await readdir(snaps)).toEqual([]);
  });

  it("aborts a zero-progress write before linking instead of looping forever", async () => {
    const dir = await createTempDir("spur-snapshots-zero-");
    await mkdir(join(dir, "sessions", session.id), { recursive: true });
    const snaps = snapshotDir(dir, session.id, session.project);
    linkState.failWith = undefined;
    linkState.zeroWrite = true;
    linkState.zeroCalls = 0;
    linkState.links = 0;
    try {
      expect(() => writeSnapshot(dir, session, { content: "one", final: false }, context)).toThrow(
        "Snapshot write made no progress",
      );
      expect(linkState.zeroCalls).toBe(1);
    } finally {
      linkState.zeroWrite = false;
    }
    expect(linkState.links).toBe(0);
    expect(await readdir(snaps)).toEqual([]);
  }, 2000);
});
