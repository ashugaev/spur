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
import type { HostInstallCheck } from "./host-install.js";
import { withTimeout } from "./promise-timeout.js";
import type { BranchExistsResponse } from "./types.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_LOCK_RETRY_MS = 25;
const WORKSPACE_LOCK_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_LOCK_FILE = "spur-workspace.lock";
// Doctor's per-project git probes (D2/D3) must never hang, unlike the much
// longer worktree-creation lock timeout above — this bounds `isGitWorktree`/
// `branchStatus` independently of that.
const PROJECT_GIT_CHECK_TIMEOUT_MS = 5_000;
// No git spawn may wait forever: a worktree on a hung mount, or an index lock
// held by a dead agent, would otherwise pin whatever awaits it (the attention
// sweep included). Mutating commands get the generous cap — `fetch` and
// `worktree add` are legitimately slow on a large repo — while the read probes
// that run per session per sweep get the short one.
const GIT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const GIT_READ_TIMEOUT_MS = 5_000;

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

// The path `createWorktree` builds and creates a worktree at. Exported so
// callers can compute the expected path up front (e.g. to refuse before
// touching git) instead of discovering it only from `createWorktree`'s
// return value.
export function worktreePathFor(
  worktreeBaseDir: string,
  projectId: string,
  sessionId: string,
): string {
  return join(worktreeBaseDir, projectId, sessionId);
}

interface LockOwner {
  pid: number;
  content: string;
}

const DEFAULT_BRANCH_HINT = "main";

async function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs });
  return stdout.trimEnd();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args, GIT_COMMAND_TIMEOUT_MS);
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
  return runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], GIT_READ_TIMEOUT_MS);
}

/**
 * Configured URL of every git remote, keyed by remote name. One spawn for the
 * whole set instead of one `remote get-url` per candidate remote, and no GitHub
 * budget at all. Empty when the repo is unreadable or has no remote.
 */
export async function readRemoteUrls(repoPath: string): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  let output: string;
  try {
    output = await runGit(
      repoPath,
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      GIT_READ_TIMEOUT_MS,
    );
  } catch {
    // Exit code 1 means "no remote configured"; anything else (missing repo,
    // hung mount hitting the timeout) reads the same way here: no remotes.
    return urls;
  }
  for (const line of output.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(\S.*)$/.exec(line.trim());
    const name = match?.[1];
    const url = match?.[2]?.trim();
    if (name && url) {
      urls.set(name, url);
    }
  }
  return urls;
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

// Public entry point for a caller outside this module (session GC) that
// needs to prune stale worktree metadata after removing one out from under
// git's back (removeWorktree's rmSync/sudo-rm fallback path can leave a
// worktree entry registered in .git/worktrees even though the directory is
// gone, which would block a later `git worktree add`/reopen at the same
// path). Every other caller of pruneWorktrees already runs inside its own
// withWorkspaceGitLock; this one takes the lock itself since GC calls it
// standalone, after its own removeWorktree calls have already released theirs.
export async function pruneRepoWorktrees(repoPath: string): Promise<void> {
  await withWorkspaceGitLock(repoPath, () => pruneWorktrees(repoPath));
}

async function gitExitCode(cwd: string, ...args: string[]): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd, timeout: GIT_READ_TIMEOUT_MS });
    return 0;
  } catch (error) {
    return errorExitCode(error) ?? 1;
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return (await gitExitCode(repoPath, "show-ref", "--verify", "--quiet", ref)) === 0;
}

// Lock-free counterpart to `branchStatus`'s two ref checks, deliberately
// without `checkedOutAt` (which routes through `findWorktreePathForBranch` ->
// `withWorkspaceGitLock` -> a real lock-file write plus `git worktree prune`
// under `.git`). `checkProjectWorkspace` (D3) only ever needs
// exists/remote — a read-only doctor check must never write to the repo's
// `.git`, and must never contend with a live spawn's workspace lock.
export async function branchRefsExist(
  repoPath: string,
  branch: string,
): Promise<{ exists: boolean; remote: boolean }> {
  const exists = await refExists(repoPath, `refs/heads/${branch}`);
  const remote = await refExists(repoPath, `refs/remotes/origin/${branch}`);
  return { exists, remote };
}

async function hasOriginRemote(repoPath: string): Promise<boolean> {
  return (await gitExitCode(repoPath, "remote", "get-url", "origin")) === 0;
}

async function fetchOrigin(repoPath: string): Promise<void> {
  if (!(await hasOriginRemote(repoPath))) {
    return;
  }
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
  const worktreePath = worktreePathFor(input.worktreeBaseDir, input.projectId, input.sessionId);
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

export interface ProjectWorkspaceCheckInput {
  projectId: string;
  path: string;
  defaultBranch: string;
  worktree: boolean;
}

// D1-D3: doctor's per-project path/git/branch validation, composed from the
// already-exported `probeWorkspace`/`isGitWorktree` primitives plus the
// lock-free `branchRefsExist` (D3 deliberately does NOT use `branchStatus`
// production spawn logic uses — that routes through a real `.git` lock-file
// write and `git worktree prune`, which a read-only doctor check must never
// do). D2/D3 are only attempted once the prior check in the chain passed
// (matching `isGitWorktree`'s own internal `workspaceExists` guard), and are
// skipped entirely when `worktree` is off (a non-worktree project never needs a git
// repo at `path` or a resolvable `defaultBranch`).
export async function checkProjectWorkspace(
  input: ProjectWorkspaceCheckInput,
): Promise<HostInstallCheck[]> {
  const { projectId, path, defaultBranch, worktree } = input;
  const checks: HostInstallCheck[] = [];

  const { exists } = probeWorkspace(path);
  checks.push({
    id: `project-path-exists:${projectId}`,
    ok: exists,
    severity: "error",
    detail: exists ? `${path} exists` : `${path} does not exist`,
    ...(exists ? {} : { fix: `create ${path} or fix projects.${projectId}.path in spur.yaml` }),
  });
  if (!exists || !worktree) {
    return checks;
  }

  // `isGitWorktree`/`branchRefsExist` route every git failure through an exit
  // code (never a throw), so the only way `withTimeout` rejects is the timeout
  // itself. A timeout is "could not determine within the budget" (slow disk /
  // heavy I/O), not a proven failure — surface it as a `warn` rather than a
  // hard `error` that would exit non-zero on an otherwise-healthy repo.
  let isRepo: boolean;
  try {
    isRepo = await withTimeout(
      isGitWorktree(path),
      PROJECT_GIT_CHECK_TIMEOUT_MS,
      `git rev-parse --git-dir timed out for ${path}`,
    );
  } catch (error) {
    checks.push({
      id: `project-path-is-git-repo:${projectId}`,
      ok: false,
      severity: "warn",
      detail: `could not determine whether ${path} is a git repository: ${errorMessage(error)}`,
    });
    return checks;
  }
  checks.push({
    id: `project-path-is-git-repo:${projectId}`,
    ok: isRepo,
    severity: "error",
    detail: isRepo ? `${path} is a git repository` : `${path} is not a git repository`,
    ...(isRepo
      ? {}
      : { fix: `initialize a git repo at ${path} or fix projects.${projectId}.path in spur.yaml` }),
  });
  if (!isRepo) {
    return checks;
  }

  let status: { exists: boolean; remote: boolean };
  try {
    status = await withTimeout(
      branchRefsExist(path, defaultBranch),
      PROJECT_GIT_CHECK_TIMEOUT_MS,
      `branch lookup timed out for ${path}`,
    );
  } catch (error) {
    checks.push({
      id: `project-default-branch-resolves:${projectId}`,
      ok: false,
      severity: "warn",
      detail: `could not determine whether defaultBranch "${defaultBranch}" resolves in ${path}: ${errorMessage(error)}`,
    });
    return checks;
  }
  // A branch that only exists as a local ref (never pushed) or only as
  // `origin/<branch>` (never checked out) are both legitimately resolvable at
  // spawn time — matches `resolveFreshBranchRef`'s own precedence.
  const resolvable = status.exists || status.remote;
  checks.push({
    id: `project-default-branch-resolves:${projectId}`,
    ok: resolvable,
    severity: "error",
    detail: resolvable
      ? `defaultBranch "${defaultBranch}" resolves (local:${status.exists} remote:${status.remote})`
      : `defaultBranch "${defaultBranch}" does not exist locally or at origin`,
    ...(resolvable
      ? {}
      : { fix: `fix projects.${projectId}.defaultBranch or push/create the branch` }),
  });
  return checks;
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
