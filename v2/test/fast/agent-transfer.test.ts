import { describe, expect, it } from "vitest";
import { buildTransferHandoffPrompt } from "../../src/agent-transfer.js";
import type { SessionRecord } from "../../src/types.js";

function baseSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1",
    project: "api",
    agent: "codex",
    model: "gpt-5",
    prompt: "Fix the login bug",
    branch: "feature/login-fix",
    worktree: true,
    worktreePath: "/tmp/worktrees/api-a1",
    tmuxSession: "api-a1",
    launchCommand: "codex",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:05:00.000Z",
    ...overrides,
  };
}

describe("buildTransferHandoffPrompt", () => {
  it("includes session identity, task, and instructions", () => {
    const prompt = buildTransferHandoffPrompt(baseSession());

    expect(prompt).toContain("Previous session: api-a1");
    expect(prompt).toContain("Previous agent: codex (gpt-5)");
    expect(prompt).toContain("Branch: feature/login-fix");
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("production-ready completion");
    expect(prompt).toContain("pull requests");
  });

  it("includes links, tags, pr, and pipeline progress", () => {
    const prompt = buildTransferHandoffPrompt(
      baseSession({
        slots: {
          links: [
            { label: "pr", url: "https://github.com/org/repo/pull/1" },
            { label: "tracker", url: "https://tracker.example/T-1" },
          ],
          tags: ["feature", "bug"],
        },
        pr: { number: 1, repo: "org/repo", url: "https://github.com/org/repo/pull/1" },
        pipeline: {
          steps: ["research", "implement", "test"],
          nextStepIndex: 1,
          status: "running",
        },
      }),
    );

    expect(prompt).toContain("pr: https://github.com/org/repo/pull/1");
    expect(prompt).toContain("tracker: https://tracker.example/T-1");
    expect(prompt).toContain("feature, bug");
    expect(prompt).toContain("[done] research");
    expect(prompt).toContain("[current] implement");
    expect(prompt).toContain("[pending] test");
  });

  it("appends the user note when provided", () => {
    const prompt = buildTransferHandoffPrompt(baseSession(), "Focus on the auth middleware.");

    expect(prompt).toContain("## Additional context from user");
    expect(prompt).toContain("Focus on the auth middleware.");
  });
});
