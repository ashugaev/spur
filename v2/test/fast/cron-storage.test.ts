import { existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CronStorageRootError,
  assertCronStorageRoot,
  clearCronStorage,
  cronStorageDir,
  cronStorageInstructions,
  ensureCronStorageDir,
  isCronSpawnOrigin,
  readCronStorage,
  readCronStorageFile,
  writeCronStorageNote,
} from "../../src/cron-storage.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDir(prefix = "spur-cron-storage-"): Promise<string> {
  const dir = await createTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

describe("cron storage path", () => {
  it("lays out <dataDir>/cron-storage/<project>/<trigger>", async () => {
    const dataDir = await newDir();
    expect(cronStorageDir(dataDir, "api", "nightly-review")).toBe(
      join(dataDir, "cron-storage", "api", "nightly-review"),
    );
  });

  it.each(["../x", "a/b", "", "a.b"])("rejects id %j", async (id) => {
    const dataDir = await newDir();
    expect(() => cronStorageDir(dataDir, id, "review")).toThrow(/Invalid cron storage id/);
    expect(() => cronStorageDir(dataDir, "api", id)).toThrow(/Invalid cron storage id/);
    expect(() => ensureCronStorageDir(dataDir, "api", id)).toThrow(/Invalid cron storage id/);
  });

  it("validates a cron origin shape", () => {
    expect(isCronSpawnOrigin({ projectId: "api", sourceId: "tick", triggerId: "review" })).toBe(
      true,
    );
    expect(isCronSpawnOrigin({ projectId: "api", sourceId: "tick" })).toBe(false);
    expect(isCronSpawnOrigin({ projectId: "../x", sourceId: "tick", triggerId: "r" })).toBe(false);
    expect(isCronSpawnOrigin("api")).toBe(false);
  });
});

describe("cron storage view", () => {
  it("returns an empty view for a missing dir", async () => {
    const dataDir = await newDir();
    expect(readCronStorage(dataDir, "api", "review")).toEqual({
      note: "",
      noteUpdatedAt: null,
      files: [],
      totalBytes: 0,
      updatedAt: null,
      truncated: false,
    });
    expect(assertCronStorageRoot(dataDir, "api", "review")).toBe(false);
    expect(readCronStorageFile(dataDir, "api", "review", "a.txt")).toBeNull();
  });

  it("lists files without note.md, sums file bytes, takes max mtime", async () => {
    const dataDir = await newDir();
    const root = ensureCronStorageDir(dataDir, "api", "review");
    await writeFile(join(root, "a.txt"), "12345");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "b.json"), "{}");
    await writeFile(join(root, "note.md"), "remember this");
    const old = new Date("2026-01-01T00:00:00.000Z");
    const newest = new Date("2026-03-01T00:00:00.000Z");
    utimesSync(join(root, "a.txt"), old, old);
    utimesSync(join(root, "nested", "b.json"), old, old);
    utimesSync(join(root, "note.md"), newest, newest);

    const view = readCronStorage(dataDir, "api", "review");
    expect(view.note).toBe("remember this");
    expect(view.noteUpdatedAt).toBe(newest.toISOString());
    expect(view.files.map((file) => file.id).sort()).toEqual(["a.txt", "nested/b.json"]);
    expect(view.totalBytes).toBe(7);
    expect(view.updatedAt).toBe(newest.toISOString());
    expect(view.truncated).toBe(false);
    expect(readCronStorageFile(dataDir, "api", "review", "nested/b.json")?.size).toBe(2);
    expect(readCronStorageFile(dataDir, "api", "review", "../x")).toBeNull();
  });

  it("reads a note.md symlinked outside the root as empty", async () => {
    const dataDir = await newDir();
    const outside = await newDir("spur-cron-outside-");
    await writeFile(join(outside, "secret.md"), "secret");
    const root = ensureCronStorageDir(dataDir, "api", "review");
    await symlink(join(outside, "secret.md"), join(root, "note.md"));
    const view = readCronStorage(dataDir, "api", "review");
    expect(view.note).toBe("");
    expect(view.noteUpdatedAt).toBeNull();
  });
});

describe("cron storage note write", () => {
  it("writes note.md and leaves no temp file", async () => {
    const dataDir = await newDir();
    const view = writeCronStorageNote(dataDir, "api", "review", "next: check PR");
    const root = cronStorageDir(dataDir, "api", "review");
    expect(view.note).toBe("next: check PR");
    expect(view.noteUpdatedAt).not.toBeNull();
    expect(view.files).toEqual([]);
    expect(readdirSync(root)).toEqual(["note.md"]);
  });

  it("replaces a symlinked note.md without touching its target", async () => {
    const dataDir = await newDir();
    const outside = await newDir("spur-cron-outside-");
    await writeFile(join(outside, "target.md"), "original");
    const root = ensureCronStorageDir(dataDir, "api", "review");
    await symlink(join(outside, "target.md"), join(root, "note.md"));
    const view = writeCronStorageNote(dataDir, "api", "review", "new");
    expect(view.note).toBe("new");
    expect(readFileSync(join(outside, "target.md"), "utf-8")).toBe("original");
  });

  it("leaves a pre-existing predictable temp name untouched and hides temp files", async () => {
    const dataDir = await newDir();
    const root = ensureCronStorageDir(dataDir, "api", "review");
    await writeFile(join(root, ".note.tmp"), "keep");
    await writeFile(join(root, ".note-0123456789abcdef.tmp"), "stale");
    const view = writeCronStorageNote(dataDir, "api", "review", "note");
    expect(readFileSync(join(root, ".note.tmp"), "utf-8")).toBe("keep");
    expect(view.files.map((file) => file.id)).toEqual([".note.tmp"]);
    expect(readdirSync(root).filter((name) => /^\.note-[0-9a-f]{16}\.tmp$/.test(name))).toEqual([
      ".note-0123456789abcdef.tmp",
    ]);
  });
});

describe("cron storage clear", () => {
  it("removes the dir", async () => {
    const dataDir = await newDir();
    writeCronStorageNote(dataDir, "api", "review", "note");
    expect(clearCronStorage(dataDir, "api", "review").note).toBe("");
    expect(existsSync(cronStorageDir(dataDir, "api", "review"))).toBe(false);
    expect(readCronStorage(dataDir, "api", "review").files).toEqual([]);
  });

  it("unlinks a symlinked root and keeps the target files", async () => {
    const dataDir = await newDir();
    const outside = await newDir("spur-cron-outside-");
    await writeFile(join(outside, "keep.txt"), "keep");
    ensureCronStorageDir(dataDir, "api", "other");
    await symlink(outside, join(dataDir, "cron-storage", "api", "review"));
    clearCronStorage(dataDir, "api", "review");
    expect(existsSync(join(dataDir, "cron-storage", "api", "review"))).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("keep");
  });
});

describe("cron storage root guard", () => {
  it("refuses a symlinked root for list, read and write", async () => {
    const dataDir = await newDir();
    const outside = await newDir("spur-cron-outside-");
    await writeFile(join(outside, "a.txt"), "a");
    ensureCronStorageDir(dataDir, "api", "other");
    await symlink(outside, join(dataDir, "cron-storage", "api", "review"));
    expect(() => readCronStorage(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(() => readCronStorageFile(dataDir, "api", "review", "a.txt")).toThrow(
      CronStorageRootError,
    );
    expect(() => writeCronStorageNote(dataDir, "api", "review", "x")).toThrow(CronStorageRootError);
    expect(readdirSync(outside)).toEqual(["a.txt"]);
  });

  it("refuses a regular file at the root", async () => {
    const dataDir = await newDir();
    ensureCronStorageDir(dataDir, "api", "other");
    await writeFile(join(dataDir, "cron-storage", "api", "review"), "file");
    expect(() => readCronStorage(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(() => ensureCronStorageDir(dataDir, "api", "review")).toThrow(CronStorageRootError);
  });

  it("refuses a symlinked cron-storage/<project> without creating the trigger dir", async () => {
    const dataDir = await newDir();
    const outside = await newDir("spur-cron-outside-");
    await mkdir(join(dataDir, "cron-storage"));
    await symlink(outside, join(dataDir, "cron-storage", "api"));
    expect(() => ensureCronStorageDir(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(existsSync(join(outside, "review"))).toBe(false);
    expect(() => readCronStorage(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(() => readCronStorageFile(dataDir, "api", "review", "a.txt")).toThrow(
      CronStorageRootError,
    );
  });

  it("refuses a symlinked cron-storage without creating the project dir", async () => {
    const dataDir = await newDir();
    const outside = await newDir("spur-cron-outside-");
    await writeFile(join(outside, "a.txt"), "a");
    await symlink(outside, join(dataDir, "cron-storage"));
    expect(() => ensureCronStorageDir(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(existsSync(join(outside, "api"))).toBe(false);
    expect(() => readCronStorage(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(() => readCronStorageFile(dataDir, "api", "review", "a.txt")).toThrow(
      CronStorageRootError,
    );
    expect(readdirSync(outside)).toEqual(["a.txt"]);
  });

  it.each([
    ["cron-storage", (dataDir: string) => join(dataDir, "cron-storage")],
    ["cron-storage/<project>", (dataDir: string) => join(dataDir, "cron-storage", "api")],
  ])("refuses a regular file at %s for every operation", async (_label, pathOf) => {
    const dataDir = await newDir();
    const path = pathOf(dataDir);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "file");
    expect(() => readCronStorage(dataDir, "api", "review")).toThrow(CronStorageRootError);
    expect(() => readCronStorageFile(dataDir, "api", "review", "a.txt")).toThrow(
      CronStorageRootError,
    );
    expect(() => writeCronStorageNote(dataDir, "api", "review", "x")).toThrow(CronStorageRootError);
    expect(() => ensureCronStorageDir(dataDir, "api", "review")).toThrow(CronStorageRootError);
  });
});

describe("cron storage instructions", () => {
  it("tells a writable session to update the storage", () => {
    const text = cronStorageInstructions(true);
    expect(text.startsWith("Cron storage:\n")).toBe(true);
    expect(text).toContain("$SPUR_CRON_STORAGE_DIR");
    expect(text).toContain("Read `note.md`");
    expect(text).toContain("Before you finish, update");
  });

  it("drops the update line for a read-only session", () => {
    const text = cronStorageInstructions(false);
    expect(text).toContain("Read `note.md`");
    expect(text).not.toContain("Before you finish, update");
  });
});
