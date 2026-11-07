import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBranchDestination, readBranchPushUrl } from "../../src/workspace.js";
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

  async function createContextRepo(branch: string) {
    const repo = await mkdtemp(join(tmpdir(), "spur-push-context-"));
    roots.push(repo);
    const git = (...args: string[]) => execFileAsync("/usr/bin/git", args, { cwd: repo });
    await git("init", "-b", branch);
    await git(
      "-c", "user.name=Spur Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "fixture",
    );
    await git("remote", "add", "origin", "https://github.com/acme/api.git");
    return { repo, git };
  }

  async function dryRun(repo: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["push", "--dry-run", "--porcelain"], {
      cwd: repo,
    });
    return stdout;
  }

  it.each(["current", "matching", "simple", "upstream", "nothing"])(
    "retains actual push and tracked ownership after rename in %s mode",
    async (mode) => {
      for (const tracking of [false, true]) {
        const { repo, git } = await createContextRepo("old");
        await git("config", "branch.old.remote", "origin");
        await git("config", "branch.old.merge", "refs/heads/old");
        await git("branch", "-m", "new");
        await git("config", "push.default", mode);
        if (tracking) {
          await git("update-ref", "refs/remotes/origin/old", "HEAD");
          await git("update-ref", "refs/remotes/origin/new", "HEAD");
        }
        const location = (branch: string) => ({ url: "https://github.com/acme/api.git", branch });
        await expect(readBranchDestination(repo, "new")).resolves.toEqual({
          status: "known",
          push:
            mode === "current" || mode === "matching"
              ? location("new")
              : mode === "upstream" ? location("old") : null,
          upstream: location("old"),
        });
      }
    },
  );

  it("knows an unpushed simple branch has no ownership locations", async () => {
    const { repo, git } = await createContextRepo("new");
    await git("config", "push.default", "simple");
    await expect(readBranchDestination(repo, "new")).resolves.toEqual({
      status: "known", push: null, upstream: null,
    });
  });

  it.each([false, true])("normalizes Git's tracking alias after rename: %s", async (renamed) => {
    const { repo, git } = await createContextRepo("old");
    await git("config", "branch.old.remote", "origin");
    await git("config", "branch.old.merge", "refs/heads/old");
    await git("update-ref", "refs/remotes/origin/old", "HEAD");
    if (renamed) await git("branch", "-m", "new");
    const branch = renamed ? "new" : "old";
    const args = ["for-each-ref", "--format=%(push)\t%(upstream)", `refs/heads/${branch}`];
    await git("config", "push.default", "upstream");
    const upstreamAtoms = await git(...args);
    const upstreamContext = await readBranchDestination(repo, branch);
    expect(upstreamContext).toEqual({
      status: "known",
      push: { url: "https://github.com/acme/api.git", branch: "old" },
      upstream: { url: "https://github.com/acme/api.git", branch: "old" },
    });
    await git("config", "push.default", "tracking");
    expect((await git(...args)).stdout).toBe(upstreamAtoms.stdout);
    await expect(readBranchDestination(repo, branch)).resolves.toEqual(upstreamContext);
    await expect(readBranchPushUrl(repo, branch)).resolves.toBe(
      renamed ? null : "https://github.com/acme/api.git",
    );
  });

  it("keeps an unsupported push mode unknown", async () => {
    const { repo, git } = await createContextRepo("new");
    await git("config", "push.default", "unsupported-mode");
    await expect(readBranchDestination(repo, "new")).resolves.toEqual({ status: "unknown" });
  });

  it.each(["simple", "current", "matching"])("accepts a remote-only %s selector without upstream", async (mode) => {
    const { repo, git } = await createContextRepo("new");
    await git("config", "branch.new.remote", "origin");
    await git("config", "push.default", mode);
    const push = mode === "simple" ? null : { url: "https://github.com/acme/api.git", branch: "new" };
    await expect(readBranchDestination(repo, "new")).resolves.toEqual({
      status: "known", push, upstream: null,
    });
    await expect(readBranchPushUrl(repo, "new")).resolves.toBe(push?.url ?? null);
  });

  it.each([false, true])("rejects an incomplete or ambiguous upstream (%s)", async (multiple) => {
    const { repo, git } = await createContextRepo("new");
    await git("config", "branch.new.merge", "refs/heads/old");
    if (multiple) {
      await git("config", "branch.new.remote", "origin");
      await git("config", "--add", "branch.new.merge", "refs/heads/new");
    }
    await expect(readBranchDestination(repo, "new")).resolves.toEqual({ status: "unknown" });
  });

  it.each(["current", "matching"])("proves unpushed %s without a remote atom", async (mode) => {
    const { repo, git } = await createContextRepo("new");
    await git("config", "push.default", mode);
    await expect(readBranchDestination(repo, "new")).resolves.toEqual({
      status: "known", push: { url: "https://github.com/acme/api.git", branch: "new" }, upstream: null,
    });
    await expect(readBranchPushUrl(repo, "new")).resolves.toBe("https://github.com/acme/api.git");
  });

  it("keeps fetch and push repository identities separate for the same ref", async () => {
    const { repo, git } = await createContextRepo("new");
    await git("remote", "set-url", "--push", "origin", "https://github.com/contributor/api.git");
    await git("config", "branch.new.remote", "origin");
    await git("config", "branch.new.merge", "refs/heads/new");
    await git("config", "push.default", "current");
    await expect(readBranchDestination(repo, "new")).resolves.toEqual({ status: "known", push: { url: "https://github.com/contributor/api.git", branch: "new" }, upstream: { url: "https://github.com/acme/api.git", branch: "new" } });
  });

  it.each([
    { targets: ["first"], expected: "first", extra: false },
    { targets: ["first", "second"], expected: null, extra: false },
    { targets: ["first", "first"], expected: "first", extra: false },
    { targets: ["first"], expected: "first", extra: true },
    { targets: [branch], expected: branch, extra: true },
    { targets: [branch, "second"], expected: null, extra: false },
    { targets: [], expected: branch, extra: false, mirror: true },
    { targets: ["first"], expected: null, extra: false, mirror: true },
  ])("proves unique configured push mappings ($targets, $extra)", async (case_) => {
    const { repo, remote } = await createRepo();
    await execFileAsync("git", ["config", `branch.${branch}.remote`, "origin"], { cwd: repo });
    await execFileAsync("git", ["config", `branch.${branch}.merge`, "refs/heads/first"], {
      cwd: repo,
    });
    for (const target of ["first", "second", branch]) {
      await execFileAsync("git", ["update-ref", `refs/remotes/origin/${target}`, "HEAD"], {
        cwd: repo,
      });
    }
    for (const target of case_.targets) {
      await execFileAsync(
        "git",
        ["config", "--add", "remote.origin.push", `refs/heads/${branch}:refs/heads/${target}`],
        { cwd: repo },
      );
    }
    if (case_.extra) {
      await execFileAsync(
        "git",
        ["config", "--add", "remote.origin.push", "refs/heads/main:refs/heads/unrelated"],
        { cwd: repo },
      );
    }
    if (case_.mirror) {
      await execFileAsync(
        "git",
        ["config", "--add", "remote.origin.push", "refs/heads/*:refs/heads/*"],
        { cwd: repo },
      );
    }

    await expect(readBranchDestination(repo, branch)).resolves.toEqual(
      case_.expected
        ? { status: "known", push: { url: remote, branch: case_.expected }, upstream: { url: remote, branch: "first" } }
        : { status: "unknown" },
    );
    await expect(readBranchPushUrl(repo, branch)).resolves.toBe(
      case_.expected === branch ? remote : null,
    );
  });

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
