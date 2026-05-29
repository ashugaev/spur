import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetGhPathCacheForTests, gh, initializeGhPath } from "../../src/gh.js";

async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeGhStub(dir: string, body: string): Promise<string> {
  const stubPath = join(dir, "gh");
  await writeFile(stubPath, body, "utf8");
  await chmod(stubPath, 0o755);
  return stubPath;
}

describe("resolveGhPath", () => {
  let savedPath: string | undefined;
  const createdDirs: string[] = [];

  beforeEach(() => {
    _resetGhPathCacheForTests();
    savedPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
    _resetGhPathCacheForTests();
  });

  it("resolves gh to an absolute path from PATH", async () => {
    const dir = await makeTempDir("spur-gh-resolve-found-");
    createdDirs.push(dir);
    const stubPath = await writeGhStub(dir, "#!/bin/sh\necho found\n");
    process.env.PATH = dir;

    await expect(initializeGhPath()).resolves.toEqual({ status: "resolved", path: stubPath });
    const stdout = await gh(dir);
    expect(stdout).toBe("found");
  });

  it("throws when gh is not on PATH", async () => {
    const dir = await makeTempDir("spur-gh-resolve-missing-");
    createdDirs.push(dir);
    process.env.PATH = dir;

    await expect(initializeGhPath()).resolves.toEqual({
      status: "unavailable",
      message: "gh not found on PATH",
    });
    await expect(gh(dir)).rejects.toThrow("gh not found on PATH");
  });

  it("refreshes the startup path for each daemon context", async () => {
    const firstDir = await makeTempDir("spur-gh-resolve-first-");
    const secondDir = await makeTempDir("spur-gh-resolve-second-");
    createdDirs.push(firstDir, secondDir);
    const firstStub = await writeGhStub(firstDir, "#!/bin/sh\necho first\n");
    const secondStub = await writeGhStub(secondDir, "#!/bin/sh\necho second\n");

    process.env.PATH = firstDir;
    await expect(initializeGhPath()).resolves.toEqual({ status: "resolved", path: firstStub });
    await expect(gh(firstDir)).resolves.toBe("first");

    process.env.PATH = secondDir;
    await expect(initializeGhPath()).resolves.toEqual({ status: "resolved", path: secondStub });
    await expect(gh(secondDir)).resolves.toBe("second");
  });

  it("keeps gh calls on the startup absolute path", async () => {
    const dir = await makeTempDir("spur-gh-resolve-cache-");
    createdDirs.push(dir);
    await writeGhStub(dir, "#!/bin/sh\necho cached\n");
    process.env.PATH = dir;

    await initializeGhPath();
    const first = await gh(dir);
    expect(first).toBe("cached");

    await rm(join(dir, "gh"), { force: true });
    process.env.PATH = "";

    await expect(gh(dir)).rejects.toThrow("gh unavailable: resolved gh at");
    await expect(gh(dir)).rejects.toThrow("is no longer executable");
  });
});
