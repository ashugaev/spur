// Pins the per-directory listing cache in v2/src/metadata.ts.
//
// The regression this guards is a COUNT, not a value: listSessions readdir'd
// EVERY subdirectory of dataDir/sessions on every call, and on a live fleet
// 1832 of those 1841 dirs are per-session log shards (todo.ts, event-log.ts)
// holding no *.json at all. Four timers call it, so only a call count can
// catch that coming back — hence the node:fs mock below, which counts
// readdirSync per path and passes everything else through to the real fs
// (precedent: session-index-cache.test.ts).
//
// Lives in its own file so the module mock cannot leak into metadata.test.ts.
//
// FIXTURE RULE: a cache hit requires (now - dir mtimeMs) > 1000 ms, so a
// fixture built and listed inside one test is too young to ever hit. Every
// case that expects a HIT ages its subdirectories with utimesSync first. Case
// 6 is the one that pins the guard itself.
import type * as NodeFs from "node:fs";
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSessions, writeSession } from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const dirReads = { byPath: new Map<string, number>() };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();

  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const path = args[0];
      if (typeof path === "string") {
        dirReads.byPath.set(path, (dirReads.byPath.get(path) ?? 0) + 1);
      }
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

const tempDirs: string[] = [];

function resetReads(): void {
  dirReads.byPath.clear();
}

function totalReadsUnder(dataDir: string): number {
  let total = 0;
  for (const [path, count] of dirReads.byPath) {
    if (path.startsWith(dataDir)) total += count;
  }
  return total;
}

beforeEach(() => {
  resetReads();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-listing-cache-");
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

function sessionsDir(dataDir: string): string {
  return join(dataDir, "sessions");
}

function projectDir(dataDir: string, project: string): string {
  return join(sessionsDir(dataDir), project);
}

// A project dir with `records` session files plus `shards` per-session log
// shard dirs holding only .jsonl — the fleet shape listSessions walks.
function seedFleet(dataDir: string, records: number, shards: number): void {
  for (let i = 0; i < records; i += 1) {
    writeSession(dataDir, session(`api-${i}`, "api", "ship it"));
  }
  for (let i = 0; i < shards; i += 1) {
    const shardDir = join(sessionsDir(dataDir), `shard-${i}`);
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(join(shardDir, "events.jsonl"), "{}\n", "utf-8");
    writeFileSync(join(shardDir, "todo.jsonl"), "{}\n", "utf-8");
  }
}

// Makes every subdirectory older than DIR_LISTING_MIN_AGE_MS so a cache hit
// is reachable at all. See the FIXTURE RULE above.
function ageSubdirs(dataDir: string): void {
  const past = new Date(Date.now() - 5_000);
  for (const entry of readdirSync(sessionsDir(dataDir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    utimesSync(join(sessionsDir(dataDir), entry.name), past, past);
  }
}

function ids(records: SessionRecord[]): string[] {
  return records.map((record) => record.id).sort();
}

describe("session directory listing cache", () => {
  it("readdirs only the root on a second listing of an unchanged fleet", async () => {
    const dataDir = await newDataDir();
    seedFleet(dataDir, 3, 40);
    ageSubdirs(dataDir);

    expect(listSessions(dataDir)).toHaveLength(3);

    resetReads();
    expect(listSessions(dataDir)).toHaveLength(3);

    // root + at most one dirty project dir. Uncached: 1 + 41.
    expect(totalReadsUnder(dataDir)).toBeLessThanOrEqual(2);
  });

  it("returns a record written into the project dir between two listings", async () => {
    const dataDir = await newDataDir();
    seedFleet(dataDir, 2, 5);
    ageSubdirs(dataDir);
    expect(ids(listSessions(dataDir))).toEqual(["api-0", "api-1"]);

    writeSession(dataDir, session("api-2", "api", "ship it too"));

    expect(ids(listSessions(dataDir))).toEqual(["api-0", "api-1", "api-2"]);
  });

  it("drops a record deleted from the project dir", async () => {
    const dataDir = await newDataDir();
    seedFleet(dataDir, 3, 5);
    ageSubdirs(dataDir);
    expect(listSessions(dataDir)).toHaveLength(3);

    rmSync(join(projectDir(dataDir, "api"), "api-1.json"));

    expect(ids(listSessions(dataDir))).toEqual(["api-0", "api-2"]);
  });

  it("reflects an in-place rewrite of a record while the name list is cached", async () => {
    const dataDir = await newDataDir();
    seedFleet(dataDir, 2, 5);
    ageSubdirs(dataDir);
    expect(listSessions(dataDir)).toHaveLength(2);

    // writeFileSync onto the same path: no rename, so the DIRECTORY mtime does
    // not move and the cached name list stays valid. Content is governed by
    // readSessionFileCached's own per-file fingerprint.
    const filePath = join(projectDir(dataDir, "api"), "api-0.json");
    const rewritten = { ...JSON.parse(readFileSync(filePath, "utf-8")), prompt: "rewritten" };
    writeFileSync(filePath, JSON.stringify(rewritten, null, 2) + "\n", "utf-8");

    resetReads();
    const listed = listSessions(dataDir);
    expect(listed.find((record) => record.id === "api-0")?.prompt).toBe("rewritten");
    // Proof the name list really came from cache on this call.
    expect(totalReadsUnder(dataDir)).toBeLessThanOrEqual(2);
  });

  it("re-reads a project dir removed and re-created under the same name", async () => {
    const dataDir = await newDataDir();
    seedFleet(dataDir, 2, 5);
    ageSubdirs(dataDir);
    expect(ids(listSessions(dataDir))).toEqual(["api-0", "api-1"]);

    // No utimesSync and no inode assertion: mkdir's fresh mtime is the whole
    // guarantee — this ext4 reuses directory inodes across rm -r + mkdir.
    rmSync(projectDir(dataDir, "api"), { recursive: true });
    writeSession(dataDir, session("api-9", "api", "replaced"));

    expect(ids(listSessions(dataDir))).toEqual(["api-9"]);
  });

  it("re-reads a directory whose mtime is younger than the min age", async () => {
    const dataDir = await newDataDir();
    seedFleet(dataDir, 2, 5);
    ageSubdirs(dataDir);
    expect(listSessions(dataDir)).toHaveLength(2);

    const now = new Date();
    utimesSync(projectDir(dataDir, "api"), now, now);

    resetReads();
    expect(listSessions(dataDir)).toHaveLength(2);
    expect(dirReads.byPath.get(projectDir(dataDir, "api")) ?? 0).toBeGreaterThanOrEqual(1);
  });
});
