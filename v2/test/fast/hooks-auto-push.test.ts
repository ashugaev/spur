import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, execFileAsync } from "../helpers/common.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const autoPushHook = join(repoRoot, ".claude/hooks/auto-push.sh");

type HookRun = {
  stderr: string;
  stdout: string;
};

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

async function makeDirtyRepo(): Promise<string> {
  const repoDir = await makeTempDir("spur-auto-push-repo-");
  await execFileAsync("git", ["init", "-b", "feature/hook-json"], { cwd: repoDir });
  await writeFile(join(repoDir, "dirty.txt"), "dirty\n", "utf8");
  return repoDir;
}

async function makeCommittedRepo(): Promise<string> {
  const repoDir = await makeTempDir("spur-auto-push-repo-");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFileAsync("git", ["remote", "add", "origin", "https://example.invalid/spur.git"], {
    cwd: repoDir,
  });
  await execFileAsync("git", ["config", "user.email", "spur@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repoDir });
  await execFileAsync("git", ["switch", "-c", "feature/hook-json"], { cwd: repoDir });
  return repoDir;
}

async function setOriginHead(repoDir: string, commit = "HEAD"): Promise<void> {
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", commit], { cwd: repoDir });
  await execFileAsync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    { cwd: repoDir },
  );
}

type GhStub = {
  binDir: string;
  calledPath: string;
};

async function makeGhStub(): Promise<GhStub> {
  const binDir = await makeTempDir("spur-auto-push-bin-");
  const ghPath = join(binDir, "gh");
  const calledPath = join(binDir, "called");
  await writeFile(
    ghPath,
    '#!/usr/bin/env sh\nprintf "called\\n" > "$GH_CALLED_PATH"\nexit "$' + '{GH_EXIT_CODE:-1}"\n',
    "utf8",
  );
  await chmod(ghPath, 0o755);
  return { binDir, calledPath };
}

async function makeStatusFailureStub(binDir: string): Promise<void> {
  const gitPath = join(binDir, "git");
  await writeFile(
    gitPath,
    '#!/usr/bin/env sh\nif [ "$1" = "status" ]; then\n  exit 1\nfi\nPATH="$' +
      '{PATH#*:}" exec git "$@"\n',
    "utf8",
  );
  await chmod(gitPath, 0o755);
}

async function runAutoPushHook(args: string[], env: NodeJS.ProcessEnv): Promise<HookRun> {
  const processEnv = { ...process.env };
  if (!("SPUR_CLOSEOUT_OWNER" in env)) delete processEnv.SPUR_CLOSEOUT_OWNER;
  if (!("SPUR_SESSION" in env)) delete processEnv.SPUR_SESSION;
  if (!("SPUR_SESSION_TOOL_DIR" in env)) delete processEnv.SPUR_SESSION_TOOL_DIR;
  const { stderr, stdout } = await execFileAsync(autoPushHook, args, {
    env: { ...processEnv, ...env },
  });
  return { stderr: String(stderr), stdout: String(stdout) };
}

function getStopHookCommands(content: string): string[] {
  const parsed = JSON.parse(content) as {
    hooks?: { Stop?: Array<{ hooks?: Array<{ command?: unknown }> }> };
  };
  return (
    parsed.hooks?.Stop?.flatMap(
      (group) =>
        group.hooks?.flatMap((hook) => (typeof hook.command === "string" ? [hook.command] : [])) ??
        [],
    ) ?? []
  );
}

describe("auto-push Stop hook", () => {
  it("exits before git or gh for a non-owner session", async () => {
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook(["codex"], {
      CLAUDE_PROJECT_DIR: "/path/that/does/not/exist",
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SPUR_CLOSEOUT_OWNER: "0",
    });

    expect(result).toEqual({ stderr: "", stdout: "" });
    await expect(readFile(calledPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits valid Codex Stop JSON for dirty branches without a PR", async () => {
    const repoDir = await makeDirtyRepo();
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook(["codex"], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { decision?: unknown; reason?: unknown };
    expect(parsed.decision).toBe("block");
    if (typeof parsed.reason !== "string") {
      throw new Error("Expected Codex block reason");
    }
    expect(parsed.reason).toContain("Problems: uncommitted no-pr");
    expect(parsed.reason).toContain("$github");
  });

  it("keeps the plain text prompt for non-Codex runtimes", async () => {
    const repoDir = await makeDirtyRepo();
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("$github");
    expect(result.stdout).toContain("Problems: uncommitted no-pr");
  });

  it("emits one block for an unchanged Spur closeout obligation", async () => {
    const repoDir = await makeDirtyRepo();
    const toolDir = await makeTempDir("spur-auto-push-tools-");
    const { binDir, calledPath } = await makeGhStub();
    const env = {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SPUR_CLOSEOUT_OWNER: "1",
      SPUR_SESSION: "api-1",
      SPUR_SESSION_TOOL_DIR: toolDir,
    };

    const first = await runAutoPushHook(["codex"], env);
    const second = await runAutoPushHook(["codex"], env);

    expect(JSON.parse(first.stdout)).toMatchObject({ decision: "block" });
    expect(second).toEqual({ stderr: "", stdout: "" });
    await expect(readFile(join(toolDir, "auto-push-stop-state"), "utf8")).resolves.toMatch(
      /^[a-f0-9]{64}\n$/,
    );
    const markerStat = await stat(join(toolDir, "auto-push-stop-state"));
    expect(markerStat.mode & 0o777).toBe(0o600);
  });

  it.each(["branch", "head", "porcelain", "problem-set"])(
    "permits one new block after a %s change",
    async (change) => {
      const repoDir = await makeCommittedRepo();
      await writeFile(join(repoDir, "dirty.txt"), "dirty\n", "utf8");
      const toolDir = await makeTempDir("spur-auto-push-tools-");
      const { binDir, calledPath } = await makeGhStub();
      const env = {
        CLAUDE_PROJECT_DIR: repoDir,
        GH_CALLED_PATH: calledPath,
        GH_EXIT_CODE: "1",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SPUR_CLOSEOUT_OWNER: "1",
        SPUR_SESSION: "api-1",
        SPUR_SESSION_TOOL_DIR: toolDir,
      };
      await runAutoPushHook([], env);

      if (change === "branch") {
        await execFileAsync("git", ["switch", "-c", "feature/changed"], { cwd: repoDir });
      } else if (change === "head") {
        await execFileAsync("git", ["commit", "--allow-empty", "-m", "changed head"], {
          cwd: repoDir,
        });
      } else if (change === "porcelain") {
        await writeFile(join(repoDir, "another.txt"), "changed\n", "utf8");
      } else {
        env.GH_EXIT_CODE = "0";
      }

      const changed = await runAutoPushHook([], env);
      const repeated = await runAutoPushHook([], env);

      expect(changed.stdout).toContain("Use the github close-out gate");
      expect(repeated).toEqual({ stderr: "", stdout: "" });
    },
  );

  it("emits no block when the per-session marker cannot be written", async () => {
    const repoDir = await makeDirtyRepo();
    const toolParent = await makeTempDir("spur-auto-push-tools-");
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook(["codex"], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SPUR_CLOSEOUT_OWNER: "1",
      SPUR_SESSION: "api-1",
      SPUR_SESSION_TOOL_DIR: join(toolParent, "missing"),
    });

    expect(result).toEqual({ stderr: "", stdout: "" });
  });

  it("skips PR lookup for a clean branch with no diff from origin HEAD", async () => {
    const repoDir = await makeCommittedRepo();
    await setOriginHead(repoDir);
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result).toEqual({ stderr: "", stdout: "" });
    await expect(readFile(calledPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs PR lookup when the clean branch differs from origin HEAD", async () => {
    const repoDir = await makeCommittedRepo();
    await setOriginHead(repoDir);
    await writeFile(join(repoDir, "feature.txt"), "feature\n", "utf8");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: repoDir });
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("ignores a synced feature upstream when the branch differs from origin HEAD", async () => {
    const repoDir = await makeCommittedRepo();
    await setOriginHead(repoDir);
    await writeFile(join(repoDir, "feature.txt"), "feature\n", "utf8");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: repoDir });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/feature/hook-json", "HEAD"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["branch", "--set-upstream-to", "origin/feature/hook-json"], {
      cwd: repoDir,
    });
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("runs PR lookup for a dirty branch with no committed diff from origin HEAD", async () => {
    const repoDir = await makeCommittedRepo();
    await setOriginHead(repoDir);
    await writeFile(join(repoDir, "dirty.txt"), "dirty\n", "utf8");
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: uncommitted no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("fails closed when worktree status cannot be read", async () => {
    const repoDir = await makeCommittedRepo();
    await setOriginHead(repoDir);
    const { binDir, calledPath } = await makeGhStub();
    await makeStatusFailureStub(binDir);

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      GH_EXIT_CODE: "0",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: uncommitted");
    expect(result.stdout).not.toContain("no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("runs PR lookup when origin HEAD is absent", async () => {
    const repoDir = await makeCommittedRepo();
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: repoDir,
    });
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("runs PR lookup when origin HEAD has a dangling target", async () => {
    const repoDir = await makeCommittedRepo();
    await execFileAsync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"],
      { cwd: repoDir },
    );
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("runs PR lookup silently when origin HEAD has unrelated history", async () => {
    const repoDir = await makeCommittedRepo();
    await execFileAsync("git", ["switch", "--orphan", "unrelated"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "unrelated"], { cwd: repoDir });
    const { stdout: unrelatedCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["switch", "feature/hook-json"], { cwd: repoDir });
    await setOriginHead(repoDir, String(unrelatedCommit).trim());
    const { binDir, calledPath } = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      GH_CALLED_PATH: calledPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Problems: no-pr");
    await expect(readFile(calledPath, "utf8")).resolves.toBe("called\n");
  });

  it("runs auto-push in Codex mode from Codex hooks config", async () => {
    const content = await readFile(join(repoRoot, ".codex/hooks.json"), "utf8");
    const commands = getStopHookCommands(content);

    expect(commands).toContain(".claude/hooks/auto-push.sh codex");
  });
});
