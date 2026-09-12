import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBuildCacheDirs } from "../../src/build-cache-scan.js";

describe("findBuildCacheDirs (real fs, mkdtemp)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spur-disk-gc-buildcache-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
});
