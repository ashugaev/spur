import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPrAlertRoutes,
  allowsPrAlertBatch,
  allowsPrAlertIdentity,
  PrAlertOwnerRequestError,
} from "../../src/pr-alert-owner.js";
import { writeSession } from "../../src/metadata.js";
import { writeWorkspaceState } from "../../src/workspace-store.js";
import type { PersistedSendBatch, ProjectConfig, SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function project(): ProjectConfig {
  return {
    path: ".",
    defaultBranch: "main",
    sessionPrefix: "api",
    worktree: true,
    restoreAfterReboot: false,
    symlinks: [],
    sidecars: {},
    backlog: {},
    sources: {
      checks: { type: "github", runOnStart: false, intervalMs: 1000, emitExisting: false },
      merges: { type: "github", runOnStart: false, intervalMs: 1000, emitExisting: false },
    },
    triggers: {
      "custom-checks": { source: "checks", event: "github:ci_failed", send: { interrupt: false } },
      "denied-checks": { source: "checks", event: "github:ci_failed", send: { interrupt: false } },
      "custom-merges": {
        source: "merges",
        event: "github:merge_conflict",
        send: { interrupt: false },
      },
    },
  };
}

function session(id: string): SessionRecord {
  return {
    id,
    workspaceId: "api-1",
    project: "api",
    agent: "claude",
    prompt: "task",
    branch: "feature/test",
    worktree: true,
    worktreePath: ".",
    tmuxSession: id,
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("explicit PR alert policy", () => {
  it("accepts custom split-source routes while denied siblings remain unnecessary", () => {
    expect(() => assertPrAlertRoutes(project(), ["custom-checks", "custom-merges"])).not.toThrow();
    expect(() => assertPrAlertRoutes(project())).not.toThrow();
  });

  it.each([{ allowed: [] }, { allowed: ["custom-checks"] }, { allowed: ["custom-merges"] }])(
    "rejects missing permitted classes: $allowed",
    ({ allowed }) => {
      expect(() => assertPrAlertRoutes(project(), allowed)).toThrow(PrAlertOwnerRequestError);
    },
  );

  it("rejects absent routes and non-GitHub send impostors", () => {
    const config = project();
    config.triggers = {};
    expect(() => assertPrAlertRoutes(config)).toThrow("github:ci_failed");
    config.triggers = project().triggers;
    config.sources = {};
    expect(() => assertPrAlertRoutes(config)).toThrow("github:ci_failed");
  });

  it("carries code and error in native invalid/conflict responses", () => {
    expect(new PrAlertOwnerRequestError("invalid", "missing route")).toMatchObject({
      statusCode: 400,
      payload: { code: "pr_alert_owner_invalid", error: "missing route" },
    });
    expect(new PrAlertOwnerRequestError("conflict", "claimed")).toMatchObject({
      statusCode: 409,
      payload: { code: "pr_alert_owner_conflict", error: "claimed" },
    });
  });

  it("selects only explicit owner and rejects stale host/repo/PR bindings", async () => {
    const dataDir = await createTempDir("spur-pr-alert-owner-");
    directories.push(dataDir);
    const owner = session("api-1");
    const helper = session("api-2");
    writeSession(dataDir, owner);
    writeSession(dataDir, helper);
    expect(allowsPrAlertIdentity(dataDir, helper, { prNumber: 42 })).toBe(true);
    const pr = { number: 42, repo: "example/repo", url: "https://github.com/example/repo/pull/42" };
    writeWorkspaceState(dataDir, "api-1", {
      pr,
      prAlertOwner: { state: "owned", sessionId: owner.id },
    });
    const batch: PersistedSendBatch = {
      kind: "review",
      providerId: "github",
      projectId: "api",
      sourceId: "checks",
      sessionId: owner.id,
      prNumber: 42,
      repo: "EXAMPLE/REPO",
      prUrl: pr.url,
      prTitle: "PR",
      signals: [],
    };
    expect(allowsPrAlertIdentity(dataDir, helper, batch)).toBe(false);
    expect(allowsPrAlertBatch(dataDir, helper, { ...batch, sessionId: helper.id })).toBe(false);
    expect(allowsPrAlertBatch(dataDir, owner, batch)).toBe(true);
    expect(
      allowsPrAlertBatch(dataDir, owner, {
        ...batch,
        prUrl: "https://elsewhere.example/example/repo/pull/42",
      }),
    ).toBe(false);
    expect(allowsPrAlertBatch(dataDir, owner, { ...batch, prNumber: 43 })).toBe(false);
    expect(
      allowsPrAlertBatch(dataDir, owner, {
        ...batch,
        repo: "example/other",
        prUrl: "https://github.com/example/other/pull/42",
      }),
    ).toBe(false);
    writeWorkspaceState(dataDir, "api-1", {
      pr,
      prAlertOwner: {
        state: "retired",
        successorSessionId: "api-3",
        successorWorkspaceId: "api-3",
      },
    });
    expect(allowsPrAlertIdentity(dataDir, owner, batch)).toBe(false);
    expect(allowsPrAlertBatch(dataDir, owner, batch)).toBe(false);
  });
});
