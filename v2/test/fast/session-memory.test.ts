import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSessionMemoryRecord,
  listSessionMemoryRecords,
  resolveSessionMemoryRecord,
  setSessionMemoryRecord,
} from "../../src/session-memory.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
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
