import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    vi.fn();
  return { execFile: mockExecFile };
});

import * as childProcess from "node:child_process";
import { orderedReviewProviderIds, reviewProvider } from "../../src/review-providers/index.js";
import type { GitHubSourceConfig, GitLabSourceConfig } from "../../src/types.js";

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

function mockGitRemote(stdout: string): void {
  mockExecFileAsync.mockResolvedValueOnce({ stdout, stderr: "" });
}

function mockGitRemoteFailure(message: string): void {
  mockExecFileAsync.mockRejectedValueOnce(new Error(message));
}

const githubSource: GitHubSourceConfig = {
  type: "github",
  runOnStart: false,
  intervalMs: 60_000,
  emitExisting: false,
};

const gitlabSource: GitLabSourceConfig = {
  type: "gitlab",
  runOnStart: false,
  intervalMs: 60_000,
  emitExisting: false,
};

describe("orderedReviewProviderIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns github from a configured github source without a git call", async () => {
    await expect(
      orderedReviewProviderIds("/wt", { sources: { gh: githubSource } }),
    ).resolves.toEqual(["github"]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns gitlab from a configured gitlab source without a git call", async () => {
    await expect(
      orderedReviewProviderIds("/wt", { sources: { gl: gitlabSource } }),
    ).resolves.toEqual(["gitlab"]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("orders github first when the origin remote is a github url", async () => {
    mockGitRemote("git@github.com:org/repo.git");

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual([
      "github",
      "gitlab",
    ]);
  });

  it("orders gitlab first when the origin remote is a gitlab url", async () => {
    mockGitRemote("git@gitlab.com:org/repo.git");

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual([
      "gitlab",
      "github",
    ]);
  });

  it("defaults to github then gitlab when no remote is available", async () => {
    mockGitRemoteFailure("no remote");

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual([
      "github",
      "gitlab",
    ]);
  });
});

describe("reviewProvider", () => {
  it("returns distinct providers matching their ids", () => {
    expect(reviewProvider("github").id).toBe("github");
    expect(reviewProvider("gitlab").id).toBe("gitlab");
  });
});
