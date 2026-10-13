import * as nodeFs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

type ReaddirImpl = (path: nodeFs.PathLike, options?: unknown) => unknown;

const readdirOverride = vi.hoisted(() => ({
  current: null as ReaddirImpl | null,
  real: null as ReaddirImpl | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  readdirOverride.real = actual.readdirSync as unknown as ReaddirImpl;
  return {
    ...actual,
    readdirSync: (path: nodeFs.PathLike, options?: unknown) =>
      readdirOverride.current
        ? readdirOverride.current(path, options)
        : (actual.readdirSync as ReaddirImpl)(path, options),
  };
});

const { listProjectSessions, listSessions, writeSession } = await import("../../src/metadata.js");

const tempDirs: string[] = [];

afterEach(async () => {
  readdirOverride.current = null;
  await Promise.all(
    tempDirs.splice(0).map((dir) => nodeFs.promises.rm(dir, { recursive: true, force: true })),
  );
});

function record(id: string, project: string): SessionRecord {
  return {
    id,
    project,
    agent: "claude",
    prompt: "ship it",
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

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-list-vanish-");
  tempDirs.push(dir);
  return dir;
}

function failChildReaddir(dir: string, code: string): void {
  const real = readdirOverride.real as ReaddirImpl;
  readdirOverride.current = (path, options) => {
    if (String(path) === dir) {
      throw Object.assign(new Error(`${code}: scandir '${dir}'`), { code });
    }
    return real(path, options);
  };
}

describe("listSessions vanished subdir", () => {
  it("skips a project dir removed between the root and child readdir", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, record("api-1", "api"));
    writeSession(dataDir, record("web-1", "web"));
    failChildReaddir(join(dataDir, "sessions", "web"), "ENOENT");

    expect(listSessions(dataDir).map((s) => s.id)).toEqual(["api-1"]);
  });

  it("listProjectSessions returns [] for a removed project dir", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, record("api-1", "api"));
    failChildReaddir(join(dataDir, "sessions", "api"), "ENOENT");

    expect(listProjectSessions(dataDir, "api")).toEqual([]);
  });

  it("still throws on a non-ENOENT child readdir failure", async () => {
    const dataDir = await newDataDir();
    writeSession(dataDir, record("api-1", "api"));
    failChildReaddir(join(dataDir, "sessions", "api"), "EACCES");

    expect(() => listSessions(dataDir)).toThrow(/EACCES/);
    expect(() => listProjectSessions(dataDir, "api")).toThrow(/EACCES/);
  });
});
