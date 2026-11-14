import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as NodeFs from "node:fs";

const linkState = vi.hoisted(() => ({ failWith: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    linkSync: (existing: string, target: string) => {
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
});
