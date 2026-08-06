import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMockState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  linkFile(source: string, target: string): void {
    if (this.files.has(target)) {
      throw fsError("EEXIST");
    }
    const value = this.files.get(source);
    if (value === undefined) {
      throw fsError("ENOENT");
    }
    this.files.set(target, value);
  },
}));

const timerMockState = vi.hoisted(() => ({
  sleeps: [] as Array<() => void>,
}));

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        timerMockState.sleeps.push(resolve);
      }),
  ),
}));

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  linkSync: vi.fn((source: string, target: string) => {
    fsMockState.linkFile(source, target);
  }),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((path: string) => {
    const value = fsMockState.files.get(path);
    if (value === undefined) {
      throw fsError("ENOENT");
    }
    return value;
  }),
  realpathSync: vi.fn((path: string) => path),
  renameSync: vi.fn((source: string, target: string) => {
    const value = fsMockState.files.get(source);
    if (value === undefined) {
      throw fsError("ENOENT");
    }
    fsMockState.files.delete(source);
    fsMockState.files.set(target, value);
  }),
  rmSync: vi.fn((path: string) => {
    fsMockState.files.delete(path);
  }),
  statSync: vi.fn(),
  symlinkSync: vi.fn(),
  unlinkSync: vi.fn((path: string) => {
    if (!fsMockState.files.delete(path)) {
      throw fsError("ENOENT");
    }
  }),
  writeFileSync: vi.fn((path: string, data: string, options?: { flag?: string }) => {
    if (options?.flag === "wx" && fsMockState.files.has(path)) {
      throw fsError("EEXIST");
    }
    fsMockState.files.set(path, data);
  }),
}));

import * as childProcess from "node:child_process";
import { existsSync, linkSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import {
  branchStatus,
  checkProjectWorkspace,
  createWorktree,
  findWorktreePathForBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  pruneRepoWorktrees,
  readCurrentBranch,
  readDoctorBranchHint,
  readRemoteUrls,
  resolveDoctorRepoRoot,
  resolveRepoPathFromWorktree,
  workspaceExists,
} from "../../src/workspace.js";

const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");

const mockExecFileAsync = (() => {
  const value = (
    childProcess.execFile as unknown as Record<symbol, ReturnType<typeof vi.fn> | undefined>
  )[PROMISIFY_CUSTOM];
  if (!value) {
    throw new Error("Expected execFile mock to expose promisify.custom");
  }
  return value;
})();
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockLinkSync = linkSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockSymlinkSync = symlinkSync as ReturnType<typeof vi.fn>;

function mockGitSuccess(stdout = ""): void {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: stdout ? `${stdout}\n` : "", stderr: "" });
}

function mockGitFailure(message: string, code = 1): void {
  mockExecFileAsync.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
}

// Every git spawn carries a timeout: no git call may wait forever. Mutating
// commands get the generous cap, read probes the short one.
function gitOpts(cwd: string): { cwd: string; timeout: number } {
  return { cwd, timeout: 5 * 60_000 };
}

function gitProbeOpts(cwd: string): { cwd: string; timeout: number } {
  return { cwd, timeout: 5_000 };
}

const baseInput = {
  repoPath: "/repo/api",
  worktreeBaseDir: "/tmp/spur-worktrees",
  projectId: "api",
  sessionId: "api-1",
  defaultBranch: "main",
  branch: "api-1",
  symlinks: [] as string[],
};

function mockWorkspaceLockResolution(): void {
  mockGitSuccess("/repo/api/.git");
}

describe("createWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
    mockExistsSync.mockReturnValue(true);
    mockLinkSync.mockImplementation((source: string, target: string) => {
      fsMockState.linkFile(source, target);
    });
    mockMkdirSync.mockClear();
    mockRmSync.mockClear();
    mockSymlinkSync.mockClear();
  });

  it("fetches origin and creates a new branch from origin/defaultBranch when available", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("missing local main");
    mockGitFailure("missing local branch");
    mockGitFailure("missing remote branch");
    mockGitSuccess();

    await createWorktree(baseInput);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "origin"],
      gitProbeOpts("/repo/api"),
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "--quiet"],
      gitOpts("/repo/api"),
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "api-1", "/tmp/spur-worktrees/api/api-1", "origin/main"],
      gitOpts("/repo/api"),
    );
  });

  it("uses origin/defaultBranch as base when checked-out default branch is dirty and behind", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("remote not behind local");
    mockGitSuccess("main");
    mockGitSuccess(" M DIRTY.txt");
    mockGitFailure("missing local branch");
    mockGitFailure("missing remote branch");
    mockGitSuccess();

    await createWorktree(baseInput);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "api-1", "/tmp/spur-worktrees/api/api-1", "origin/main"],
      gitOpts("/repo/api"),
    );
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      "git",
      ["merge", "--ff-only", "origin/main"],
      gitOpts("/repo/api"),
    );
  });

  it("fast-forwards a clean checked-out default branch before creating the worktree", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("remote not behind local");
    mockGitSuccess("main");
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("missing local branch");
    mockGitFailure("missing remote branch");
    mockGitSuccess();

    await createWorktree(baseInput);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["merge", "--ff-only", "origin/main"],
      gitOpts("/repo/api"),
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "api-1", "/tmp/spur-worktrees/api/api-1", "main"],
      gitOpts("/repo/api"),
    );
  });

  it("creates an explicit branch from origin/<branch> when it only exists remotely", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("missing local main");
    mockGitFailure("missing local release");
    mockGitSuccess();
    mockGitFailure("missing local release");
    mockGitSuccess();

    await createWorktree({
      ...baseInput,
      branch: "release",
    });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "release", "/tmp/spur-worktrees/api/api-1", "origin/release"],
      gitOpts("/repo/api"),
    );
  });

  it("fast-forwards an existing local branch from origin before adding the worktree", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("missing local main");
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("remote not behind local");
    mockGitSuccess("main");
    mockGitSuccess();
    mockGitSuccess();

    await createWorktree({
      ...baseInput,
      branch: "feature/fresh",
    });

    const forceUpdateCall = mockExecFileAsync.mock.calls.find(
      (call) =>
        call[0] === "git" &&
        JSON.stringify(call[1]) ===
          JSON.stringify(["branch", "-f", "feature/fresh", "origin/feature/fresh"]),
    );
    expect(forceUpdateCall).toEqual([
      "git",
      ["branch", "-f", "feature/fresh", "origin/feature/fresh"],
      gitOpts("/repo/api"),
    ]);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/tmp/spur-worktrees/api/api-1", "feature/fresh"],
      gitOpts("/repo/api"),
    );
  });

  it("fails fast when origin cannot be fetched", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess();
    mockGitFailure("network down");

    await expect(createWorktree(baseInput)).rejects.toThrow("Failed to fetch origin: network down");

    expect(
      mockExecFileAsync.mock.calls.some(
        (call) =>
          call[0] === "git" &&
          Array.isArray(call[1]) &&
          call[1][0] === "worktree" &&
          call[1][1] === "add",
      ),
    ).toBe(false);
  });

  it("skips the origin fetch and resolves the local branch when the repo has no origin remote", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess(); // worktree prune
    mockGitFailure("no such remote 'origin'", 2); // remote get-url origin
    mockGitFailure("missing remote main"); // refExists origin/main
    mockGitFailure("missing local branch"); // refExists heads/api-1
    mockGitFailure("missing remote branch"); // refExists origin/api-1
    mockGitSuccess(); // worktree add

    await createWorktree(baseInput);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "origin"],
      gitProbeOpts("/repo/api"),
    );
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      "git",
      ["fetch", "origin", "--quiet"],
      gitOpts("/repo/api"),
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "api-1", "/tmp/spur-worktrees/api/api-1", "main"],
      gitOpts("/repo/api"),
    );
  });

  it("waits for a valid metadata lock holder longer than five seconds", async () => {
    const events: string[] = [];
    let firstAddStarted!: () => void;
    let firstAddRelease!: () => void;
    const firstAddStartedPromise = new Promise<void>((resolve) => {
      firstAddStarted = resolve;
    });
    const firstAddReleasePromise = new Promise<void>((resolve) => {
      firstAddRelease = resolve;
    });

    mockExecFileAsync.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
        return { stdout: "/repo/api/.git\n", stderr: "" };
      }
      if (JSON.stringify(args) === JSON.stringify(["worktree", "prune", "--expire", "now"])) {
        events.push("worktree prune");
        return { stdout: "", stderr: "" };
      }
      if (JSON.stringify(args) === JSON.stringify(["fetch", "origin", "--quiet"])) {
        events.push("fetch");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        throw Object.assign(new Error("missing ref"), { code: 1 });
      }
      if (args[0] === "worktree" && args[1] === "add") {
        if (args[4] === "/tmp/spur-worktrees/api/api-1") {
          events.push("first worktree add start");
          firstAddStarted();
          await firstAddReleasePromise;
          events.push("first worktree add end");
          return { stdout: "", stderr: "" };
        }
        events.push("second worktree add start");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const first = createWorktree(baseInput);
    await firstAddStartedPromise;

    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(5_001);
    dateNow.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(5_001);

    const second = createWorktree({
      ...baseInput,
      sessionId: "api-2",
      branch: "api-2",
    });
    for (let attempt = 0; attempt < 10 && timerMockState.sleeps.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(timerMockState.sleeps).toHaveLength(1);
    expect(events).toEqual(["worktree prune", "fetch", "first worktree add start"]);

    firstAddRelease();
    await first;
    timerMockState.sleeps.shift()?.();
    await second;
    dateNow.mockRestore();

    expect(events).toEqual([
      "worktree prune",
      "fetch",
      "first worktree add start",
      "first worktree add end",
      "worktree prune",
      "fetch",
      "second worktree add start",
    ]);
  });

  it("does not remove a fresh metadata lock when stale cleanup races with another waiter", async () => {
    const lockPath = "/repo/api/.git/spur-workspace.lock";
    const staleContent = "424242:stale-token";
    const freshContent = "12345:fresh-token";
    fsMockState.files.set(lockPath, `${staleContent}\n`);

    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number | NodeJS.Signals) => {
      if (pid === 424242) {
        throw Object.assign(new Error("dead process"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
    mockLinkSync.mockImplementation((source: string, target: string) => {
      fsMockState.linkFile(source, target);
      if (target === `${lockPath}.reap`) {
        fsMockState.files.set(lockPath, `${freshContent}\n`);
      }
    });
    mockExecFileAsync.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
        return { stdout: "/repo/api/.git\n", stderr: "" };
      }
      if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        throw Object.assign(new Error("missing ref"), { code: 1 });
      }
      return { stdout: "", stderr: "" };
    });

    const worktree = createWorktree(baseInput);
    for (let attempt = 0; attempt < 10 && timerMockState.sleeps.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(timerMockState.sleeps).toHaveLength(1);
    expect(fsMockState.files.get(lockPath)).toBe(`${freshContent}\n`);
    expect(
      mockExecFileAsync.mock.calls.some(
        (call) =>
          call[0] === "git" &&
          Array.isArray(call[1]) &&
          call[1][0] === "worktree" &&
          call[1][1] === "add",
      ),
    ).toBe(false);

    fsMockState.files.delete(lockPath);
    timerMockState.sleeps.shift()?.();
    await expect(worktree).resolves.toBe("/tmp/spur-worktrees/api/api-1");
    kill.mockRestore();
  });
});

describe("resolveRepoPathFromWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("returns the repo root from the worktree git common dir", async () => {
    mockGitSuccess("/repo/api/.git");

    await expect(resolveRepoPathFromWorktree("/tmp/spur-worktrees/api/api-1")).resolves.toBe(
      "/repo/api",
    );

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      gitOpts("/tmp/spur-worktrees/api/api-1"),
    );
  });

  it("returns undefined when the worktree repo root cannot be resolved", async () => {
    mockGitFailure("missing worktree");

    await expect(resolveRepoPathFromWorktree("/tmp/spur-worktrees/api/api-1")).resolves.toBe(
      undefined,
    );
  });
});

describe("workspaceExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts symlinks to directories", () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    expect(workspaceExists("/repo-link")).toBe(true);
  });

  it("returns false when the workspace path is unavailable", () => {
    mockStatSync.mockImplementation(() => {
      throw new Error("missing");
    });

    expect(workspaceExists("/missing")).toBe(false);
  });
});

describe("findWorktreePathForBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("returns the checked-out worktree path for the branch", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main

worktree /tmp/spur-worktrees/api/api-1
HEAD 2222222
branch refs/heads/feature/runtime-preflight
`);

    await expect(findWorktreePathForBranch("/repo/api", "feature/runtime-preflight")).resolves.toBe(
      "/tmp/spur-worktrees/api/api-1",
    );
  });

  it("returns null when no worktree has the branch checked out", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main
`);

    await expect(findWorktreePathForBranch("/repo/api", "feature/missing")).resolves.toBeNull();
  });
});

describe("pruneRepoWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("acquires the workspace lock and runs git worktree prune", async () => {
    mockWorkspaceLockResolution();
    mockGitSuccess();

    await pruneRepoWorktrees("/repo/api");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "prune", "--expire", "now"],
      gitOpts("/repo/api"),
    );
  });

  it("does not throw when git worktree prune fails", async () => {
    mockWorkspaceLockResolution();
    mockGitFailure("prune failed");

    await expect(pruneRepoWorktrees("/repo/api")).resolves.toBeUndefined();
  });
});

describe("branchStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  // checkedOutAt is resolved via findWorktreePathForBranch, so each case mocks
  // refExists(local), refExists(remote), then the lock + prune + worktree list.
  it("reports an absent branch", async () => {
    mockGitFailure("missing local");
    mockGitFailure("missing remote");
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main
`);

    await expect(branchStatus("/repo/api", "feature/new")).resolves.toEqual({
      exists: false,
      remote: false,
      checkedOutAt: null,
    });
  });

  it("reports a local-only branch with no worktree", async () => {
    mockGitSuccess();
    mockGitFailure("missing remote");
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main
`);

    await expect(branchStatus("/repo/api", "feature/local")).resolves.toEqual({
      exists: true,
      remote: false,
      checkedOutAt: null,
    });
  });

  it("reports the worktree path when the branch is checked out", async () => {
    mockGitSuccess();
    mockGitFailure("missing remote");
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main

worktree /tmp/spur-worktrees/api/api-1
HEAD 2222222
branch refs/heads/feature/checked-out
`);

    await expect(branchStatus("/repo/api", "feature/checked-out")).resolves.toEqual({
      exists: true,
      remote: false,
      checkedOutAt: "/tmp/spur-worktrees/api/api-1",
    });
  });

  it("reports a remote-only branch", async () => {
    mockGitFailure("missing local");
    mockGitSuccess();
    mockWorkspaceLockResolution();
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main
`);

    await expect(branchStatus("/repo/api", "feature/remote")).resolves.toEqual({
      exists: false,
      remote: true,
      checkedOutAt: null,
    });
  });
});

describe("checkProjectWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  const baseProjectInput = {
    projectId: "api",
    path: "/repo/api",
    defaultBranch: "main",
    worktree: true,
  };

  it("D1: reports a single failing check for a missing path and never touches git", async () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const checks = await checkProjectWorkspace(baseProjectInput);

    expect(checks).toEqual([
      expect.objectContaining({
        id: "project-path-exists:api",
        ok: false,
        severity: "error",
      }),
    ]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("D2: skips the git-repo check entirely when worktree mode is off", async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    const checks = await checkProjectWorkspace({ ...baseProjectInput, worktree: false });

    expect(checks).toEqual([expect.objectContaining({ id: "project-path-exists:api", ok: true })]);
    expect(checks.find((check) => check.id === "project-path-is-git-repo:api")).toBeUndefined();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("D3: reports a remote-only default branch as resolvable, without touching the workspace lock or worktree prune", async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockGitSuccess(); // isGitWorktree: git rev-parse --git-dir
    mockGitFailure("missing local"); // branchRefsExist: refs/heads/main
    mockGitSuccess(); // branchRefsExist: refs/remotes/origin/main

    const checks = await checkProjectWorkspace(baseProjectInput);

    expect(checks.find((check) => check.id === "project-default-branch-resolves:api")).toEqual(
      expect.objectContaining({ ok: true, severity: "error" }),
    );
    // D3 must be lock-free and read-only: exactly the 3 calls above (no
    // workspace-lock resolution, no `git worktree prune`, no `worktree list`).
    expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
  });

  it("D3: reports a default branch resolvable neither locally nor remotely as an error, without touching the workspace lock or worktree prune", async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockGitSuccess(); // isGitWorktree: git rev-parse --git-dir
    mockGitFailure("missing local"); // branchRefsExist: refs/heads/main
    mockGitFailure("missing remote"); // branchRefsExist: refs/remotes/origin/main

    const checks = await checkProjectWorkspace(baseProjectInput);

    expect(checks.find((check) => check.id === "project-default-branch-resolves:api")).toEqual(
      expect.objectContaining({ ok: false, severity: "error" }),
    );
    expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
  });

  // A git call that never settles (slow disk / heavy I/O) trips the 5s
  // `withTimeout`. That is "could not determine", not a proven failure — it
  // must warn, never a hard error that would exit non-zero on a healthy repo.
  it("D2: reports warn (not error) when the git-repo check times out", async () => {
    vi.useFakeTimers();
    try {
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockExecFileAsync.mockReturnValueOnce(new Promise(() => {})); // isGitWorktree hangs
      const pending = checkProjectWorkspace(baseProjectInput);
      await vi.advanceTimersByTimeAsync(5_000);
      const checks = await pending;
      expect(checks.find((check) => check.id === "project-path-is-git-repo:api")).toEqual(
        expect.objectContaining({ ok: false, severity: "warn" }),
      );
      // The branch check must never run once the repo check is unresolved.
      expect(
        checks.find((check) => check.id === "project-default-branch-resolves:api"),
      ).toBeUndefined();
      expect(checks.some((check) => !check.ok && check.severity === "error")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("D3: reports warn (not error) when the branch lookup times out", async () => {
    vi.useFakeTimers();
    try {
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockGitSuccess(); // isGitWorktree: git rev-parse --git-dir
      mockExecFileAsync.mockReturnValueOnce(new Promise(() => {})); // branchRefsExist hangs
      const pending = checkProjectWorkspace(baseProjectInput);
      await vi.advanceTimersByTimeAsync(5_000);
      const checks = await pending;
      expect(checks.find((check) => check.id === "project-default-branch-resolves:api")).toEqual(
        expect.objectContaining({ ok: false, severity: "warn" }),
      );
      expect(checks.some((check) => !check.ok && check.severity === "error")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readDoctorBranchHint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("returns the checked-out branch when HEAD is attached", async () => {
    mockGitSuccess("feature/onboarding");

    await expect(readDoctorBranchHint("/repo/api")).resolves.toBe("feature/onboarding");
  });

  it("falls back to the remote default branch when HEAD is detached", async () => {
    mockGitFailure("detached");
    mockGitSuccess("");
    mockGitSuccess("origin/main");

    await expect(readDoctorBranchHint("/repo/api")).resolves.toBe("main");
  });

  it("falls back to main when the repo does not expose a branch hint", async () => {
    mockGitFailure("missing");
    mockGitSuccess("");
    mockGitFailure("missing");
    mockGitFailure("missing");

    await expect(readDoctorBranchHint("/repo/api")).resolves.toBe("main");
  });
});

describe("resolveDoctorRepoRoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("returns the git toplevel when doctor runs from a nested repo directory", async () => {
    mockGitSuccess("/repo/api");

    await expect(resolveDoctorRepoRoot("/repo/api/packages/service")).resolves.toBe("/repo/api");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      gitOpts("/repo/api/packages/service"),
    );
  });

  it("falls back to the current directory when git toplevel resolution fails", async () => {
    mockGitFailure("not a git repo");

    await expect(resolveDoctorRepoRoot("/tmp/scratch")).resolves.toBe("/tmp/scratch");
  });
});

describe("hasUncommittedChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("returns true when git status reports changes", async () => {
    mockGitSuccess(" M src/foo.ts");

    await expect(hasUncommittedChanges("/wt")).resolves.toBe(true);
  });

  it("returns false when git status is empty", async () => {
    mockGitSuccess("");

    await expect(hasUncommittedChanges("/wt")).resolves.toBe(false);
  });

  it("forwards ignoredPaths as :(exclude) pathspecs", async () => {
    mockGitSuccess("");

    await hasUncommittedChanges("/wt", ["node_modules", "dist"]);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["status", "--short", "--", ".", ":(exclude)node_modules", ":(exclude)dist"],
      gitOpts("/wt"),
    );
  });
});

describe("hasUnpushedCommits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("returns false when HEAD is an ancestor of the upstream", async () => {
    mockGitSuccess("origin/feat");
    mockGitSuccess("");

    await expect(hasUnpushedCommits("/wt")).resolves.toBe(false);
  });

  it("returns true when HEAD is not an ancestor of the upstream", async () => {
    mockGitSuccess("origin/feat");
    mockGitFailure("not ancestor", 1);

    await expect(hasUnpushedCommits("/wt")).resolves.toBe(true);
  });

  it("returns true when there is no upstream and no remote contains HEAD", async () => {
    mockGitFailure("no upstream", 128);
    mockGitSuccess("");

    await expect(hasUnpushedCommits("/wt")).resolves.toBe(true);
  });

  it("returns false when there is no upstream but a remote contains HEAD", async () => {
    mockGitFailure("no upstream", 128);
    mockGitSuccess("  origin/feat");

    await expect(hasUnpushedCommits("/wt")).resolves.toBe(false);
  });
});

describe("git read probes", () => {
  const readOpts = gitProbeOpts("/wt");

  beforeEach(() => {
    vi.clearAllMocks();
    fsMockState.files.clear();
    timerMockState.sleeps = [];
  });

  it("bounds the branch probe with the short read timeout", async () => {
    mockGitSuccess("feature/live");

    await expect(readCurrentBranch("/wt")).resolves.toBe("feature/live");
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      readOpts,
    );
  });

  it("reads every remote url in one bounded spawn", async () => {
    mockGitSuccess(
      "remote.origin.url git@github.com:acme/api.git\nremote.upstream.url https://github.com/base/api.git",
    );

    await expect(readRemoteUrls("/wt")).resolves.toEqual(
      new Map([
        ["origin", "git@github.com:acme/api.git"],
        ["upstream", "https://github.com/base/api.git"],
      ]),
    );
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      readOpts,
    );
  });

  it("reads no remotes when the probe fails", async () => {
    mockGitFailure("not a git repository", 128);

    await expect(readRemoteUrls("/wt")).resolves.toEqual(new Map());
  });
});
