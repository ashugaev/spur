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
  createWorktree,
  findWorktreePathForBranch,
  readDoctorBranchHint,
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
    mockGitFailure("missing local main");
    mockGitFailure("missing local branch");
    mockGitFailure("missing remote branch");
    mockGitSuccess();

    await createWorktree(baseInput);

    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/repo/api",
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "api-1", "/tmp/spur-worktrees/api/api-1", "origin/main"],
      { cwd: "/repo/api" },
    );
  });

  it("uses origin/defaultBranch as base when checked-out default branch is dirty and behind", async () => {
    mockWorkspaceLockResolution();
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
      { cwd: "/repo/api" },
    );
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      "git",
      ["merge", "--ff-only", "origin/main"],
      { cwd: "/repo/api" },
    );
  });

  it("fast-forwards a clean checked-out default branch before creating the worktree", async () => {
    mockWorkspaceLockResolution();
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

    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["merge", "--ff-only", "origin/main"], {
      cwd: "/repo/api",
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "api-1", "/tmp/spur-worktrees/api/api-1", "main"],
      { cwd: "/repo/api" },
    );
  });

  it("creates an explicit branch from origin/<branch> when it only exists remotely", async () => {
    mockWorkspaceLockResolution();
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
      { cwd: "/repo/api" },
    );
  });

  it("fast-forwards an existing local branch from origin before adding the worktree", async () => {
    mockWorkspaceLockResolution();
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
      { cwd: "/repo/api" },
    ]);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/tmp/spur-worktrees/api/api-1", "feature/fresh"],
      { cwd: "/repo/api" },
    );
  });

  it("fails fast when origin cannot be fetched", async () => {
    mockWorkspaceLockResolution();
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
      { cwd: "/tmp/spur-worktrees/api/api-1" },
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
      { cwd: "/repo/api/packages/service" },
    );
  });

  it("falls back to the current directory when git toplevel resolution fails", async () => {
    mockGitFailure("not a git repo");

    await expect(resolveDoctorRepoRoot("/tmp/scratch")).resolves.toBe("/tmp/scratch");
  });
});
