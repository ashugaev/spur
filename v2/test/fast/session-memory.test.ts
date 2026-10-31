import type * as NodeFs from "node:fs";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionMemoryRecord,
  listSessionMemoryRecords,
  resolveSessionMemoryRecord,
  setSessionMemoryRecord,
  writeFileAtomic,
} from "../../src/session-memory.js";
import { createTempDir } from "../helpers/common.js";

const fsFault = vi.hoisted(() => ({
  failWrite: false,
  failUnlink: false,
  failReaddir: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      if (fsFault.failReaddir) {
        throw Object.assign(new Error("readdir denied"), { code: "EACCES" });
      }
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFault.failWrite) {
        actual.writeFileSync(args[0], "partial", "utf-8");
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      }
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => {
      if (fsFault.failUnlink) {
        throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
      }
      return actual.unlinkSync(...args);
    }) as typeof actual.unlinkSync,
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  fsFault.failWrite = false;
  fsFault.failUnlink = false;
  fsFault.failReaddir = false;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-session-memory-");
  tempDirs.push(dir);
  return dir;
}

function readRawMemoryFile(dataDir: string, sessionId: string): unknown {
  try {
    return JSON.parse(
      readFileSync(join(dataDir, "session-memory", `${sessionId}.json`), "utf-8"),
    ) as unknown;
  } catch (error) {
    throw new Error("Failed to read memory file", { cause: error });
  }
}

describe("session memory storage", () => {
  it("sets records sorted by key and normalizes tags", async () => {
    const dataDir = await newDataDir();

    setSessionMemoryRecord(dataDir, "spur_123", {
      key: "zeta",
      body: "last",
      tags: ["Bug", "bug", "plan"],
      now: "2026-06-15T10:00:00.000Z",
    });
    setSessionMemoryRecord(dataDir, "spur_123", {
      key: "alpha",
      body: "first",
      now: "2026-06-15T10:01:00.000Z",
    });

    expect(listSessionMemoryRecords(dataDir, "spur_123").map((record) => record.key)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(getSessionMemoryRecord(dataDir, "spur_123", "zeta")).toEqual({
      key: "zeta",
      kind: "note",
      body: "last",
      status: "active",
      tags: ["bug", "plan"],
      createdAt: "2026-06-15T10:00:00.000Z",
      updatedAt: "2026-06-15T10:00:00.000Z",
    });
    expect(readRawMemoryFile(dataDir, "spur_123")).toEqual({
      records: [
        expect.objectContaining({ key: "alpha" }),
        expect.objectContaining({ key: "zeta" }),
      ],
    });
  });

  it("updates records while preserving createdAt and clearing resolvedAt", async () => {
    const dataDir = await newDataDir();

    setSessionMemoryRecord(dataDir, "spur-123", {
      key: "decision.api",
      body: "old",
      now: "2026-06-15T10:00:00.000Z",
    });
    expect(
      resolveSessionMemoryRecord(dataDir, "spur-123", "decision.api", "2026-06-15T10:02:00.000Z"),
    ).toEqual(expect.objectContaining({ status: "resolved" }));

    const updated = setSessionMemoryRecord(dataDir, "spur-123", {
      key: "decision.api",
      body: "new",
      tags: [],
      now: "2026-06-15T10:03:00.000Z",
    });

    expect(updated).toEqual({
      key: "decision.api",
      kind: "note",
      body: "new",
      status: "active",
      tags: [],
      createdAt: "2026-06-15T10:00:00.000Z",
      updatedAt: "2026-06-15T10:03:00.000Z",
    });
  });

  it("returns null when resolving a missing key", async () => {
    const dataDir = await newDataDir();

    expect(resolveSessionMemoryRecord(dataDir, "spur-123", "missing")).toBeNull();
  });

  it("rejects invalid session ids, keys, and tags", async () => {
    const dataDir = await newDataDir();

    expect(() => listSessionMemoryRecords(dataDir, "../bad")).toThrow(/session id/);
    expect(() => getSessionMemoryRecord(dataDir, "spur-123", "Bad")).toThrow(/key/);
    expect(() =>
      setSessionMemoryRecord(dataDir, "spur-123", {
        key: "valid",
        body: "text",
        tags: ["bad tag"],
      }),
    ).toThrow(/tags/);
  });
});

describe("writeFileAtomic temp file hygiene", () => {
  it("commits the write when stale tmp enumeration is denied", async () => {
    const dir = await newDataDir();
    const target = join(dir, "key.md");
    writeFileSync(target, "old body");
    fsFault.failReaddir = true;

    writeFileAtomic(target, "new body");

    expect(readFileSync(target, "utf-8")).toBe("new body");
    fsFault.failReaddir = false;
    expect(readdirSync(dir)).toEqual(["key.md"]);
  });

  it("cleans the failed write and preserves its error when enumeration is denied", async () => {
    const dir = await newDataDir();
    fsFault.failReaddir = true;
    fsFault.failWrite = true;

    expect(() => writeFileAtomic(join(dir, "key.md"), "body")).toThrow(
      expect.objectContaining({ code: "ENOSPC" }),
    );
    fsFault.failReaddir = false;
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the tmp file and rethrows when rename fails", async () => {
    const dir = await newDataDir();
    const target = join(dir, "key.md");
    mkdirSync(join(target, "child"), { recursive: true });

    expect(() => writeFileAtomic(target, "body")).toThrow(
      expect.objectContaining({ code: "EISDIR" }),
    );
    expect(readdirSync(dir)).toEqual(["key.md"]);
  });

  it("rethrows the original write error when tmp cleanup also fails", async () => {
    const dir = await newDataDir();
    fsFault.failWrite = true;
    fsFault.failUnlink = true;

    expect(() => writeFileAtomic(join(dir, "key.md"), "body")).toThrow(
      expect.objectContaining({ code: "ENOSPC" }),
    );
  });

  it("removes the tmp file and rethrows the original error when write fails", async () => {
    const dir = await newDataDir();
    fsFault.failWrite = true;

    expect(() => writeFileAtomic(join(dir, "key.md"), "body")).toThrow(/no space/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes dead-pid siblings of the same key on the next write", async () => {
    const dir = await newDataDir();
    const dead = "key.md.tmp.2147483646.1700000000000";
    const otherKey = "other.md.tmp.2147483646.1700000000000";
    writeFileSync(join(dir, dead), "x");
    writeFileSync(join(dir, otherKey), "x");

    writeFileAtomic(join(dir, "key.md"), "body");

    expect(readdirSync(dir).sort()).toEqual(["key.md", otherKey]);
  });

  it("keeps siblings owned by a live pid", async () => {
    const dir = await newDataDir();
    const live = `key.md.tmp.${process.ppid}.1700000000000`;
    writeFileSync(join(dir, live), "x");

    writeFileAtomic(join(dir, "key.md"), "body");

    expect(readdirSync(dir).sort()).toEqual(["key.md", live]);
  });
});
