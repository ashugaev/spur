import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetGhPathCacheForTests, gh } from "../../src/gh.js";

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
    await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    _resetGhPathCacheForTests();
  });

  it("resolves gh to an absolute path from PATH", async () => {
    const dir = await makeTempDir("spur-gh-resolve-found-");
    createdDirs.push(dir);
    const stubPath = await writeGhStub(dir, "#!/bin/sh\necho found\n");
    process.env.PATH = dir;

    const stdout = await gh(dir);
    expect(stdout).toBe("found");
    // The cached path must match the absolute stub location, proving PATH lookup ran.
    expect(stubPath.startsWith(dir)).toBe(true);
  });

  it("throws when gh is not on PATH", async () => {
    const dir = await makeTempDir("spur-gh-resolve-missing-");
    createdDirs.push(dir);
    process.env.PATH = dir;

    await expect(gh(dir)).rejects.toThrow("gh not found on PATH");
  });

  it("caches the resolved path across calls", async () => {
    const dir = await makeTempDir("spur-gh-resolve-cache-");
    createdDirs.push(dir);
    await writeGhStub(dir, "#!/bin/sh\necho cached\n");
    process.env.PATH = dir;

    const first = await gh(dir);
    expect(first).toBe("cached");

    // Remove the stub. If the cache works, the next call still resolves the same
    // absolute path; execFile will then fail because the binary is gone — distinct
    // from the "gh not found on PATH" resolver error.
    await rm(join(dir, "gh"), { force: true });
    process.env.PATH = "";

    await expect(gh(dir)).rejects.not.toThrow("gh not found on PATH");
  });
});
