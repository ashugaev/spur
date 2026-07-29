// Deliberately does NOT mock "node:child_process": exercises the real `git`
// binary in a disposable temp repo to prove `readGitDescribedVersion` reports
// the actual reachable release tag instead of a static number. The bug this
// guards against: falling back to the repo root package.json, whose version
// field is never bumped and always read "0.1.0" -- the very first version
// ever assigned -- for any git-deployed or source-run daemon.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("returns undefined outside a git repo", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "spur-version-not-git-"));
    try {
      expect(readGitDescribedVersion(pathToFileURL(`${notARepo}/`))).toBeUndefined();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
