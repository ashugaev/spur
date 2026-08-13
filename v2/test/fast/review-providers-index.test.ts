import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readRemoteUrlsMock } = vi.hoisted(() => ({
  readRemoteUrlsMock: vi.fn(),
}));

vi.mock("../../src/workspace.js", () => ({
  readRemoteUrls: readRemoteUrlsMock,
}));

import { orderedReviewProviderIds, reviewProvider } from "../../src/review-providers/index.js";
import type { GitHubSourceConfig, GitLabSourceConfig } from "../../src/types.js";

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
    expect(readRemoteUrlsMock).not.toHaveBeenCalled();
  });

  it("returns gitlab from a configured gitlab source without a git call", async () => {
    await expect(
      orderedReviewProviderIds("/wt", { sources: { gl: gitlabSource } }),
    ).resolves.toEqual(["gitlab"]);
    expect(readRemoteUrlsMock).not.toHaveBeenCalled();
  });

  it("returns only github when every remote is github.com", async () => {
    readRemoteUrlsMock.mockResolvedValue(new Map([["origin", "git@github.com:org/repo.git"]]));

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual(["github"]);
  });

  it("keeps gitlab's turn when a gitlab remote sits beside a github remote", async () => {
    readRemoteUrlsMock.mockResolvedValue(
      new Map([
        ["upstream", "git@github.com:org/repo.git"],
        ["origin", "git@gitlab.com:org/repo.git"],
      ]),
    );

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual([
      "gitlab",
      "github",
    ]);
  });

  it("pins the pre-existing whole-url github match for a gitlab remote named github-tools", async () => {
    readRemoteUrlsMock.mockResolvedValue(
      new Map([["origin", "git@gitlab.com:org/github-tools.git"]]),
    );

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual([
      "github",
      "gitlab",
    ]);
  });

  it("keeps both providers for a GitHub Enterprise host", async () => {
    readRemoteUrlsMock.mockResolvedValue(new Map([["origin", "git@github.acme.com:org/repo.git"]]));

    await expect(orderedReviewProviderIds("/wt", { sources: {} })).resolves.toEqual([
      "github",
      "gitlab",
    ]);
  });

  it("defaults to github then gitlab when no remote is available", async () => {
    readRemoteUrlsMock.mockResolvedValue(new Map());

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
