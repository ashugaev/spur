import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lstatMock } = vi.hoisted(() => ({ lstatMock: vi.fn() }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return { ...actual, lstat: lstatMock };
});

const { findBuildCacheDirs } = await import("../../src/build-cache-scan.js");
const actualFsPromises = await vi.importActual<typeof FsPromises>("node:fs/promises");

describe("findBuildCacheDirs (real fs, mkdtemp)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spur-disk-gc-buildcache-"));
    lstatMock.mockImplementation((path: string) => actualFsPromises.lstat(path));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    lstatMock.mockReset();
  });

  it("finds .cache/webpack and .next/cache, skips node_modules, never the worktree root", async () => {
    await mkdir(join(root, "front", ".cache", "webpack"), { recursive: true });
    await mkdir(join(root, "packages", "web", ".next", "cache"), { recursive: true });
    await mkdir(join(root, "front", "node_modules", "webpack"), { recursive: true });
    await mkdir(join(root, "front", "node_modules", "@svgr", "webpack"), { recursive: true });
    await writeFile(join(root, "front", ".cache", "webpack", "data.pack"), "x");

    const found = await findBuildCacheDirs(root);
    const paths = found.map((f) => f.path).sort();

    expect(paths).toEqual(
      [
        join(root, "front", ".cache", "webpack"),
        join(root, "packages", "web", ".next", "cache"),
      ].sort(),
    );
    expect(paths).not.toContain(root);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("cleanup 2: a build-cache dir that vanishes between the walk's own lstat and newestMtimeMs's lstat is skipped, not fatal", async () => {
    await mkdir(join(root, "front", ".cache", "webpack"), { recursive: true });
    await mkdir(join(root, "packages", "web", ".next", "cache"), { recursive: true });
    const vanishingPath = join(root, "front", ".cache", "webpack");

    // The walk loop's OWN lstat (checking isDirectory) succeeds normally;
    // simulate the dir vanishing exactly between that call and
    // newestMtimeMs's own lstat on the same path (real host churn — this
    // host removes worktrees/build caches constantly).
    let callsOnVanishingPath = 0;
    lstatMock.mockImplementation((path: string) => {
      if (path === vanishingPath) {
        callsOnVanishingPath += 1;
        if (callsOnVanishingPath === 2) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          return Promise.reject(error);
        }
      }
      return actualFsPromises.lstat(path);
    });

    const found = await findBuildCacheDirs(root);
    const paths = found.map((f) => f.path);

    // Dropped, not fatal: the OTHER real candidate is still found and the
    // whole plan does not abort/reject.
    expect(paths).not.toContain(vanishingPath);
    expect(paths).toContain(join(root, "packages", "web", ".next", "cache"));
  });
});
