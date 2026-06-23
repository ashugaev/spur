import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

interface GitWorktreeEntry {
  path: string;
  branch?: string;
}

const DEFAULT_BRANCH_HINT = "main";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

async function tryGit(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, ...args);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ") && current) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

export async function readCurrentBranch(repoPath: string): Promise<string> {
  return git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
}

function normalizeBranchHint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "HEAD") {
    return undefined;
  }
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

export async function readDoctorBranchHint(repoPath: string): Promise<string> {
  const currentBranch = normalizeBranchHint(
    await tryGit(repoPath, "symbolic-ref", "--quiet", "--short", "HEAD"),
  );
  if (currentBranch) {
    return currentBranch;
  }

  const checkedOutBranch = normalizeBranchHint(await tryGit(repoPath, "branch", "--show-current"));
  if (checkedOutBranch) {
    return checkedOutBranch;
  }

  const remoteDefaultBranch = normalizeBranchHint(
    await tryGit(repoPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
  );
  if (remoteDefaultBranch) {
    return remoteDefaultBranch;
  }

  return (
    normalizeBranchHint(await tryGit(repoPath, "config", "--get", "init.defaultBranch")) ??
    DEFAULT_BRANCH_HINT
  );
}

export async function resolveDoctorRepoRoot(startDir: string): Promise<string> {
  const repoRoot = await tryGit(startDir, "rev-parse", "--path-format=absolute", "--show-toplevel");
  return repoRoot ? resolve(repoRoot) : resolve(startDir);
}

export async function findWorktreePathForBranch(
  repoPath: string,
  branch: string,
): Promise<string | null> {
  await pruneWorktrees(repoPath);
  const output = await git(repoPath, "worktree", "list", "--porcelain");
  const match = parseWorktreeList(output).find((entry) => entry.branch === branch);
  return match?.path ?? null;
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

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return (await gitExitCode(repoPath, "show-ref", "--verify", "--quiet", ref)) === 0;
}

async function fetchOrigin(repoPath: string): Promise<void> {
  try {
    await git(repoPath, "fetch", "origin", "--quiet");
  } catch (error) {
    throw new Error(`Failed to fetch origin: ${errorMessage(error)}`, { cause: error });
  }
}

interface ResolveFreshBranchRefOptions {
  useRemoteWhenCheckedOutDirty?: boolean;
}

async function resolveFreshBranchRef(
  repoPath: string,
  branch: string,
  options?: ResolveFreshBranchRefOptions,
): Promise<string> {
  const remoteBranch = `origin/${branch}`;
  if (!(await refExists(repoPath, `refs/remotes/origin/${branch}`))) {
    return branch;
  }
  if (!(await refExists(repoPath, `refs/heads/${branch}`))) {
    return remoteBranch;
  }

  const localBehindRemote =
    (await gitExitCode(repoPath, "merge-base", "--is-ancestor", branch, remoteBranch)) === 0;
  const remoteBehindOrEqualLocal =
    (await gitExitCode(repoPath, "merge-base", "--is-ancestor", remoteBranch, branch)) === 0;
  if (!localBehindRemote || remoteBehindOrEqualLocal) {
    return branch;
  }

  try {
    if ((await readCurrentBranch(repoPath)) === branch) {
      if (options?.useRemoteWhenCheckedOutDirty && (await hasUncommittedChanges(repoPath))) {
        return remoteBranch;
      }
      await git(repoPath, "merge", "--ff-only", remoteBranch);
      return branch;
    }
    await git(repoPath, "branch", "-f", branch, remoteBranch);
  } catch (error) {
    throw new Error(
      `Failed to fast-forward local branch "${branch}" to ${remoteBranch}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return branch;
}

function applySymlink(repoPath: string, worktreePath: string, relativePath: string): void {
  const sourcePath = join(repoPath, relativePath);
  const targetPath = join(worktreePath, relativePath);

  if (!existsSync(sourcePath)) {
    process.stderr.write(`Symlink source not found (skipping): ${sourcePath}\n`);
    return;
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
  await fetchOrigin(input.repoPath);
  const defaultBranchRef = await resolveFreshBranchRef(input.repoPath, input.defaultBranch, {
    useRemoteWhenCheckedOutDirty: true,
  });
  const branchExistsLocally = await refExists(input.repoPath, `refs/heads/${input.branch}`);

  if (branchExistsLocally) {
    if (input.branch !== input.defaultBranch) {
      await resolveFreshBranchRef(input.repoPath, input.branch);
    }
    await git(input.repoPath, "worktree", "add", worktreePath, input.branch);
  } else {
    let baseRef = defaultBranchRef;
    if (input.branch !== input.defaultBranch) {
      const branchRef = await resolveFreshBranchRef(input.repoPath, input.branch);
      if (branchRef !== input.branch) {
        baseRef = branchRef;
      }
    }
    await git(input.repoPath, "worktree", "add", "-b", input.branch, worktreePath, baseRef);
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

  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // Root-owned files (e.g. from Docker) block rmSync; escalate via sudo.
    execFileSync("sudo", ["rm", "-rf", worktreePath]);
  }
}

export async function resolveRepoPathFromWorktree(
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const gitCommonDir = await git(
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    return basename(gitCommonDir) === ".git" ? dirname(gitCommonDir) : undefined;
  } catch {
    return undefined;
  }
}

export function workspaceExists(worktreePath: string): boolean {
  try {
    return statSync(worktreePath).isDirectory();
  } catch {
    return false;
  }
}

export async function hasUncommittedChanges(
  worktreePath: string,
  ignoredPaths: string[] = [],
): Promise<boolean> {
  const output = await git(
    worktreePath,
    "status",
    "--short",
    "--",
    ".",
    ...ignoredPaths.map((path) => `:(exclude)${path}`),
  );
  return output.trim().length > 0;
}

export async function hasUnpushedCommits(worktreePath: string): Promise<boolean> {
  const upstream = await tryGit(
    worktreePath,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  );
  if (upstream) {
    return (await gitExitCode(worktreePath, "merge-base", "--is-ancestor", "HEAD", upstream)) !== 0;
  }

  const remoteContainingHead = await git(worktreePath, "branch", "-r", "--contains", "HEAD");
  return remoteContainingHead.trim().length === 0;
}
