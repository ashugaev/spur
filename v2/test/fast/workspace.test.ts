import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  symlinkSync: vi.fn(),
}));

import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import {
  createWorktree,
  findWorktreePathForBranch,
  resolveRepoPathFromWorktree,
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
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
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

describe("createWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReset();
    mockRmSync.mockReset();
    mockSymlinkSync.mockReset();
  });

  it("fetches origin and creates a new branch from origin/defaultBranch when available", async () => {
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

  it("creates an explicit branch from origin/<branch> when it only exists remotely", async () => {
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
});

describe("resolveRepoPathFromWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

describe("findWorktreePathForBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the checked-out worktree path for the branch", async () => {
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main

worktree /tmp/spur-worktrees/api/api-1
HEAD 2222222
branch refs/heads/feature/runtime-preflight
`);

    await expect(
      findWorktreePathForBranch("/repo/api", "feature/runtime-preflight"),
    ).resolves.toBe("/tmp/spur-worktrees/api/api-1");
  });

  it("returns null when no worktree has the branch checked out", async () => {
    mockGitSuccess();
    mockGitSuccess(`worktree /repo/api
HEAD 1111111
branch refs/heads/main
`);

    await expect(findWorktreePathForBranch("/repo/api", "feature/missing")).resolves.toBeNull();
  });
});
