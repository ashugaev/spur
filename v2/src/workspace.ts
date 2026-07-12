import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { BranchExistsResponse } from "./types.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_LOCK_RETRY_MS = 25;
const WORKSPACE_LOCK_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_LOCK_FILE = "spur-workspace.lock";

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

interface LockOwner {
  pid: number;
  content: string;
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

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | undefined {
  if (!objectRecord(error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorExitCode(error: unknown): number | undefined {
  if (!objectRecord(error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function parseLockOwner(raw: string): LockOwner | null {
  const content = raw.trim();
  const separatorIndex = content.indexOf(":");
  const pidText = separatorIndex === -1 ? content : content.slice(0, separatorIndex);
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 ? { pid, content } : null;
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    return parseLockOwner(readFileSync(lockPath, "utf-8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createLockFile(lockPath: string): string {
  const ownerContent = `${process.pid}:${randomUUID()}`;
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${ownerContent}\n`, { encoding: "utf-8", flag: "wx" });
  try {
    linkSync(tempPath, lockPath);
    return ownerContent;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function releaseLockFile(lockPath: string, ownerContent: string): void {
  try {
    if (readLockOwner(lockPath)?.content === ownerContent) {
      unlinkSync(lockPath);
    }
  } catch {
    // Best effort cleanup only.
  }
}

function reapDeadLock(lockPath: string, owner: LockOwner): boolean {
  if (isProcessAlive(owner.pid)) {
    return false;
  }

  const reapLockPath = `${lockPath}.reap`;
  let reapOwnerContent: string;
  try {
    reapOwnerContent = createLockFile(reapLockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    const currentOwner = readLockOwner(lockPath);
    if (currentOwner?.content !== owner.content || isProcessAlive(currentOwner.pid)) {
      return false;
    }
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
  } finally {
    releaseLockFile(reapLockPath, reapOwnerContent);
  }
}

async function resolveWorkspaceLockPath(repoPath: string): Promise<string> {
  const gitCommonDir = await git(
    repoPath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return join(realpathSync(gitCommonDir), WORKSPACE_LOCK_FILE);
}

async function withWorkspaceGitLock<T>(repoPath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = await resolveWorkspaceLockPath(repoPath);
  const deadline = Date.now() + WORKSPACE_LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const ownerContent = createLockFile(lockPath);
      try {
        return await run();
      } finally {
        releaseLockFile(lockPath, ownerContent);
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      const owner = readLockOwner(lockPath);
      if (owner !== null && reapDeadLock(lockPath, owner)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace git metadata lock: ${lockPath}`, {
          cause: error,
        });
      }

      await sleep(WORKSPACE_LOCK_RETRY_MS);
    }
  }
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
  return withWorkspaceGitLock(repoPath, async () => {
    await pruneWorktrees(repoPath);
    const output = await git(repoPath, "worktree", "list", "--porcelain");
    const match = parseWorktreeList(output).find((entry) => entry.branch === branch);
    return match?.path ?? null;
  });
}

export async function branchStatus(
  repoPath: string,
  branch: string,
): Promise<BranchExistsResponse> {
  const exists = await refExists(repoPath, `refs/heads/${branch}`);
  const remote = await refExists(repoPath, `refs/remotes/origin/${branch}`);
  // Reuse the spawn path's checkout lookup so the warning agrees with what a
  // real spawn would see (it prunes stale worktrees under the workspace lock).
  const checkedOutAt = await findWorktreePathForBranch(repoPath, branch);
  return { exists, remote, checkedOutAt };
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
    return errorExitCode(error) ?? 1;
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

  await withWorkspaceGitLock(input.repoPath, async () => {
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
  });

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
    await withWorkspaceGitLock(repoPath, async () => {
      await git(repoPath, "worktree", "remove", "--force", worktreePath);
    });
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

export function probeWorkspace(worktreePath: string): { exists: boolean; missing: boolean } {
  if (!worktreePath) {
    return { exists: false, missing: false };
  }
  try {
    return { exists: statSync(worktreePath).isDirectory(), missing: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { exists: false, missing: code === "ENOENT" };
  }
}

export async function isGitWorktree(worktreePath: string): Promise<boolean> {
  if (!workspaceExists(worktreePath)) {
    return false;
  }
  return (await gitExitCode(worktreePath, "rev-parse", "--git-dir")) === 0;
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
