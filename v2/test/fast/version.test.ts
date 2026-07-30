// Deliberately does NOT mock "node:child_process": exercises the real `git`
// binary in a disposable temp repo to prove `readGitDescribedVersion` reports
// the actual reachable release tag instead of a static number. The bug this
// guards against: falling back to the repo root package.json, whose version
// field is never bumped and always read "0.1.0" -- the very first version
// ever assigned -- for any git-deployed or source-run daemon.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readGitDescribedVersion } from "../../src/version.js";

describe("readGitDescribedVersion (real git)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "spur-version-git-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function commit(message: string): Promise<void> {
    await writeFile(join(repo, "file.txt"), message);
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo });
  }

  it("reports the release tag on an exact match", async () => {
    await commit("release commit");
    execFileSync("git", ["tag", "v1.2.3"], { cwd: repo });

    expect(readGitDescribedVersion(pathToFileURL(`${repo}/`))).toBe("1.2.3");
  });

  it("reports <tag>-<commits>-g<sha> past a release, not the bare tag", async () => {
    await commit("release commit");
    execFileSync("git", ["tag", "v1.2.3"], { cwd: repo });
    await commit("follow-up commit");

    const described = readGitDescribedVersion(pathToFileURL(`${repo}/`));
    expect(described).toMatch(/^1\.2\.3-1-g[0-9a-f]+$/);
  });

  it("ignores non-release tags like a stray tmp-evidence marker", async () => {
    await commit("first commit");
    execFileSync("git", ["tag", "tmp-evidence-90"], { cwd: repo });
    await commit("release commit");
    execFileSync("git", ["tag", "v2.0.0"], { cwd: repo });

    expect(readGitDescribedVersion(pathToFileURL(`${repo}/`))).toBe("2.0.0");
  });

  it("falls back to the abbreviated commit hash when no release tag is reachable", async () => {
    await commit("untagged commit");

    const described = readGitDescribedVersion(pathToFileURL(`${repo}/`));
    expect(described).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("returns undefined when repoRoot is nested inside an ancestor repo instead of being its own toplevel", async () => {
    // Simulates the npm-install-gone-wrong case: `repoRoot` (node_modules/@shugaev/,
    // one level short of the package root) sits *inside* the outer repo rather
    // than being its toplevel. Must not describe the outer repo's tags.
    await commit("release commit");
    execFileSync("git", ["tag", "v9.9.9"], { cwd: repo });
    const nested = join(repo, "nested");
    await mkdir(nested, { recursive: true });

    expect(readGitDescribedVersion(pathToFileURL(`${nested}/`))).toBeUndefined();
  });

  it("returns undefined outside a git repo", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "spur-version-not-git-"));
    // Without this, "outside a git repo" only holds because `tmpdir()`
    // happens not to sit under an ancestor `.git` on this host. Pin the
    // ceiling so git can't walk up past `notARepo` and the intent holds
    // regardless of where the real ancestor tree does or doesn't have one.
    const originalCeiling = process.env["GIT_CEILING_DIRECTORIES"];
    process.env["GIT_CEILING_DIRECTORIES"] = notARepo;
    try {
      expect(readGitDescribedVersion(pathToFileURL(`${notARepo}/`))).toBeUndefined();
    } finally {
      if (originalCeiling === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
      else process.env["GIT_CEILING_DIRECTORIES"] = originalCeiling;
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
