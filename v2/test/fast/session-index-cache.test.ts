// Pins the .index.json cache in v2/src/metadata.ts.
//
// The regression this guards is a COUNT, not a value: before the cache, every
// readSession() re-read and re-parsed the whole session index, which on a live
// fleet is a 113 KB / 2305-entry file rebuilt once per record per sweep. Only a
// call count can catch that coming back, hence the node:fs mock below — it
// counts readFileSync calls against .index.json and passes everything else
// through to the real fs (precedent: session-artifacts-fs-fault.test.ts).
//
// Lives in its own file so the module mock cannot leak into metadata.test.ts.
import type * as NodeFs from "node:fs";
import { readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, writeSession } from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const indexReads = { count: 0 };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();

  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const path = args[0];
      if (typeof path === "string" && path.endsWith(".index.json")) {
        indexReads.count += 1;
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  indexReads.count = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-index-cache-");
  tempDirs.push(dir);
  return dir;
}

function session(id: string, project: string, prompt: string): SessionRecord {
  return {
    id,
    project,
    workspaceId: id,
    agent: "claude",
    prompt,
    branch: id,
    worktree: true,
    worktreePath: `/tmp/spur-worktrees/${project}/${id}`,
    tmuxSession: id,
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:01:00.000Z",
  };
}

function indexPath(dataDir: string): string {
  return join(dataDir, "sessions", ".index.json");
}

function indexJson(mapping: Record<string, string>): string {
  return JSON.stringify(mapping, null, 2) + "\n";
}

// Drops the cache without changing what the index says: same bytes, fresh inode.
function bustCache(dataDir: string): void {
  const path = indexPath(dataDir);
  const tmpPath = `${path}.bust`;
  writeFileSync(tmpPath, readFileSync(path, "utf-8"), "utf-8");
  renameSync(tmpPath, path);
}

describe("session index cache", () => {
  it("reads .index.json once across many readSession calls", async () => {
    const dataDir = await newDataDir();
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = `api-${i}`;
      ids.push(id);
      writeSession(dataDir, session(id, "api", "ship it"));
    }

    bustCache(dataDir);
    indexReads.count = 0;

    for (const id of ids) {
      expect(readSession(dataDir, id)?.id).toBe(id);
    }

    expect(indexReads.count).toBe(1);
  });

  it("keeps the cache hot across an in-process index write", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, session("api-1", "api", "ship it"));
    expect(readSession(dataDir, "api-1")?.id).toBe("api-1");

    indexReads.count = 0;

    writeSession(dataDir, session("api-2", "api", "ship it too"));
    expect(readSession(dataDir, "api-2")?.id).toBe("api-2");
    expect(readSession(dataDir, "api-1")?.id).toBe("api-1");

    expect(indexReads.count).toBe(0);
  });

  it("picks up an out-of-band in-place rewrite on the next read", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, session("api-1", "apione", "first"));
    // A second record for the same id under another project, reachable only
    // through the index mapping.
    writeSession(dataDir, session("api-1", "apitwo", "second"));

    writeFileSync(
      indexPath(dataDir),
      indexJson({ "api-1": "sessions/apione/api-1.json" }),
      "utf-8",
    );
    expect(readSession(dataDir, "api-1")?.prompt).toBe("first");

    indexReads.count = 0;
    writeFileSync(
      indexPath(dataDir),
      indexJson({ "api-1": "sessions/apitwo/api-1.json" }),
      "utf-8",
    );

    expect(readSession(dataDir, "api-1")?.prompt).toBe("second");
    expect(indexReads.count).toBe(1);
  });

  it("picks up an out-of-band rename-in with an identical size and mtime", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, session("api-1", "apione", "first"));
    writeSession(dataDir, session("api-1", "apitwo", "second"));

    const path = indexPath(dataDir);
    const pinned = new Date(1_700_000_000_000);
    writeFileSync(path, indexJson({ "api-1": "sessions/apione/api-1.json" }), "utf-8");
    utimesSync(path, pinned, pinned);
    const before = statSync(path);
    expect(readSession(dataDir, "api-1")?.prompt).toBe("first");

    // Same byte length, same mtime, new inode: only the ino leg of the
    // fingerprint can catch this one.
    const tmpPath = `${path}.foreign`;
    writeFileSync(tmpPath, indexJson({ "api-1": "sessions/apitwo/api-1.json" }), "utf-8");
    utimesSync(tmpPath, pinned, pinned);
    renameSync(tmpPath, path);

    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);

    expect(readSession(dataDir, "api-1")?.prompt).toBe("second");
  });

  it("falls back to the directory scan when .index.json is deleted", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, session("api-1", "api", "ship it"));
    expect(readSession(dataDir, "api-1")?.id).toBe("api-1");

    unlinkSync(indexPath(dataDir));

    expect(() => readSession(dataDir, "api-1")).not.toThrow();
    expect(readSession(dataDir, "api-1")?.id).toBe("api-1");
  });
});
