import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CreateWorktreeInput {
  repoPath: string;
  worktreeBaseDir: string;
  projectId: string;
  sessionId: string;
  defaultBranch: string;
  branch: string;
  symlinks: string[];
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

export async function readCurrentBranch(repoPath: string): Promise<string> {
  return git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
}

async function pruneWorktrees(repoPath: string): Promise<void> {
  try {
    await git(repoPath, "worktree", "prune", "--expire", "now");
  } catch {
    // Best effort only.
  }
}

async function gitExitCode(cwd: string, ...args: string[]): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd });
    return 0;
  } catch (error) {
    const exitCode = (error as { code?: number }).code;
    return typeof exitCode === "number" ? exitCode : 1;
  }
}

function applySymlink(repoPath: string, worktreePath: string, relativePath: string): void {
  const sourcePath = join(repoPath, relativePath);
  const targetPath = join(worktreePath, relativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(`Symlink source not found: ${sourcePath}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  rmSync(targetPath, { recursive: true, force: true });
  symlinkSync(sourcePath, targetPath);
}

export async function createWorktree(input: CreateWorktreeInput): Promise<string> {
  const projectDir = join(input.worktreeBaseDir, input.projectId);
  const worktreePath = join(projectDir, input.sessionId);
  mkdirSync(projectDir, { recursive: true });
  await pruneWorktrees(input.repoPath);
  const branchExistsLocally =
    (await gitExitCode(
      input.repoPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${input.branch}`,
    )) === 0;

  if (branchExistsLocally) {
    await git(input.repoPath, "worktree", "add", worktreePath, input.branch);
  } else {
    await git(
      input.repoPath,
      "worktree",
      "add",
      "-b",
      input.branch,
      worktreePath,
      input.defaultBranch,
    );
  }

  try {
    for (const relativePath of input.symlinks) {
      applySymlink(input.repoPath, worktreePath, relativePath);
    }
  } catch (error) {
    await removeWorktree(input.repoPath, worktreePath);
    throw error;
  }

  return worktreePath;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await git(repoPath, "worktree", "remove", "--force", worktreePath);
    return;
  } catch {
    // Fall back to direct removal below.
  }

  rmSync(worktreePath, { recursive: true, force: true });
}

export function workspaceExists(worktreePath: string): boolean {
  try {
    return lstatSync(worktreePath).isDirectory();
  } catch {
    return false;
  }
}
