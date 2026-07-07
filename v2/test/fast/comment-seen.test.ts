import { describe, expect, it } from "vitest";
import { recordReviewCommentsSeen } from "../../src/comment-seen.js";
import { readCommentSeenRegistry } from "../../src/metadata.js";
import type { ProjectConfig, SourceConfig } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

function githubSource(): SourceConfig {
  return { type: "github", runOnStart: false, intervalMs: 60_000, emitExisting: false };
}

function gitlabSource(): SourceConfig {
  return { type: "gitlab", runOnStart: false, intervalMs: 60_000, emitExisting: false };
}

function project(sources: Record<string, SourceConfig>): ProjectConfig {
  return {
    path: "/repo",
    defaultBranch: "main",
    sessionPrefix: "api",
    worktree: true,
    restoreAfterReboot: false,
    symlinks: [],
    sidecars: {},
    sources,
    backlog: {},
    triggers: {},
  };
}

describe("recordReviewCommentsSeen", () => {
  it("records namespaced review-comment ids for every github source", async () => {
    const dataDir = await createTempDir("spur-comment-seen-");
    const projects = {
      api: project({ "pr-watch": githubSource(), "pr-watch-2": githubSource() }),
    };

    recordReviewCommentsSeen({ dataDir, projects }, "api", [7001, "7002"]);

    for (const sourceId of ["pr-watch", "pr-watch-2"]) {
      const ids = readCommentSeenRegistry(dataDir, "api", sourceId);
      expect(ids.has("review-comment:7001")).toBe(true);
      expect(ids.has("review-comment:7002")).toBe(true);
      expect(ids.has("7001")).toBe(false);
      expect(ids.size).toBe(2);
    }
  });

  it("skips non-github sources", async () => {
    const dataDir = await createTempDir("spur-comment-seen-");
    const projects = { api: project({ gl: gitlabSource() }) };

    recordReviewCommentsSeen({ dataDir, projects }, "api", [7001]);

    expect(readCommentSeenRegistry(dataDir, "api", "gl").size).toBe(0);
  });

  it("is a no-op when the project has no github sources", async () => {
    const dataDir = await createTempDir("spur-comment-seen-");
    const projects = { api: project({}) };
    expect(() => recordReviewCommentsSeen({ dataDir, projects }, "api", [7001])).not.toThrow();
  });

  it("throws for an unknown project", async () => {
    const dataDir = await createTempDir("spur-comment-seen-");
    const projects = { api: project({ "pr-watch": githubSource() }) };
    expect(() => recordReviewCommentsSeen({ dataDir, projects }, "other", [7001])).toThrow(
      /Unknown project/,
    );
  });
});
