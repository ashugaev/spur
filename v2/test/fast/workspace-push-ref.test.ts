import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBranchPushUrl } from "../../src/workspace.js";
import { execFileAsync } from "../helpers/common.js";

describe("branch push destination", () => {
  const roots: string[] = [];
  const branch = "feature/x";

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRepo(): Promise<{ repo: string; remote: string }> {
    const root = await mkdtemp(join(tmpdir(), "spur-push-ref-"));
    roots.push(root);
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    await mkdir(repo);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repo });
    await execFileAsync("git", ["switch", "-c", branch], { cwd: repo });
    return { repo, remote };
  }

  async function dryRun(repo: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["push", "--dry-run", "--porcelain"], {
      cwd: repo,
    });
    return stdout;
  }

  it("accepts a current-mode push to the same branch", async () => {
    const { repo, remote } = await createRepo();
    await execFileAsync("git", ["config", "push.default", "current"], { cwd: repo });
    await execFileAsync("git", ["config", "remote.pushDefault", "origin"], { cwd: repo });

    expect(await dryRun(repo)).toContain("refs/heads/feature/x:refs/heads/feature/x");
    await expect(readBranchPushUrl(repo, branch)).resolves.toBe(remote);
  });

  it("rejects an upstream push to a different branch", async () => {
    const { repo } = await createRepo();
    await execFileAsync("git", ["push", "origin", "HEAD:refs/heads/other"], { cwd: repo });
    await execFileAsync("git", ["config", "branch.feature/x.remote", "origin"], { cwd: repo });
    await execFileAsync("git", ["config", "branch.feature/x.merge", "refs/heads/other"], {
      cwd: repo,
    });
    await execFileAsync("git", ["config", "push.default", "upstream"], { cwd: repo });

    expect(await dryRun(repo)).toContain("refs/heads/feature/x:refs/heads/other");
    await expect(readBranchPushUrl(repo, branch)).resolves.toBeNull();
  });

  it("rejects a custom fetch mapping that disguises the push destination", async () => {
    const { repo } = await createRepo();
    await execFileAsync("git", ["push", "origin", "HEAD:refs/heads/other"], { cwd: repo });
    await execFileAsync("git", ["config", "branch.feature/x.remote", "origin"], { cwd: repo });
    await execFileAsync("git", ["config", "branch.feature/x.merge", "refs/heads/other"], {
      cwd: repo,
    });
    await execFileAsync("git", ["config", "push.default", "upstream"], { cwd: repo });
    await execFileAsync(
      "git",
      [
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/other:refs/remotes/origin/feature/x",
      ],
      { cwd: repo },
    );
    await execFileAsync("git", ["fetch", "origin"], { cwd: repo });

    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--format=%(push)", `refs/heads/${branch}`],
      { cwd: repo },
    );
    expect(stdout.trim()).toBe("refs/remotes/origin/feature/x");
    expect(await dryRun(repo)).toContain("refs/heads/feature/x:refs/heads/other");
    await expect(readBranchPushUrl(repo, branch)).resolves.toBeNull();
  });

  it("checks an explicit remote push refspec", async () => {
    const { repo, remote } = await createRepo();
    await execFileAsync("git", ["config", "push.default", "current"], { cwd: repo });
    await execFileAsync("git", ["config", "remote.pushDefault", "origin"], { cwd: repo });
    await execFileAsync(
      "git",
      ["config", "remote.origin.push", "refs/heads/feature/x:refs/heads/other"],
      {
        cwd: repo,
      },
    );

    expect(await dryRun(repo)).toContain("refs/heads/feature/x:refs/heads/other");
    await expect(readBranchPushUrl(repo, branch)).resolves.toBeNull();

    await execFileAsync(
      "git",
      [
        "config",
        "--replace-all",
        "remote.origin.push",
        "refs/heads/feature/x:refs/heads/feature/x",
      ],
      {
        cwd: repo,
      },
    );
    expect(await dryRun(repo)).toContain("refs/heads/feature/x:refs/heads/feature/x");
    await expect(readBranchPushUrl(repo, branch)).resolves.toBe(remote);
  });

  it("does not infer a default destination from a past explicit push", async () => {
    const { repo } = await createRepo();
    await execFileAsync("git", ["config", "push.default", "simple"], { cwd: repo });
    const { stdout } = await execFileAsync(
      "git",
      ["push", "--dry-run", "--porcelain", "origin", branch],
      {
        cwd: repo,
      },
    );
    expect(stdout).toContain("refs/heads/feature/x:refs/heads/feature/x");
    await execFileAsync("git", ["push", "origin", branch], { cwd: repo });
    await expect(
      execFileAsync("git", ["push", "--dry-run", "--porcelain"], { cwd: repo }),
    ).rejects.toThrow();
    await expect(readBranchPushUrl(repo, branch)).resolves.toBeNull();
  });
});
