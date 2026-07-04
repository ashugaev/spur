import { describe, expect, it } from "vitest";
import { renderHandoffPrompt } from "../../src/handoff-prompt.js";

describe("renderHandoffPrompt", () => {
  it("includes source session, task, and production guidance", () => {
    const prompt = renderHandoffPrompt({
      sourceSessionId: "spur-442a",
      sourceAgent: "codex",
      branch: "feature/agent-handoff",
      worktreePath: "/tmp/worktrees/sp/spur-442a",
      originalPrompt: "Add agent handoff button",
      title: "Agent handoff",
      links: [{ label: "pr", url: "https://github.com/org/repo/pull/442" }],
      tags: ["feature"],
      notes: "Prefer cursor for UI work",
    });

    expect(prompt).toContain("Task handoff from session spur-442a (codex).");
    expect(prompt).toContain("Branch: feature/agent-handoff");
    expect(prompt).toContain("Add agent handoff button");
    expect(prompt).toContain("Session title: Agent handoff");
    expect(prompt).toContain("Tags: feature");
    expect(prompt).toContain("https://github.com/org/repo/pull/442");
    expect(prompt).toContain("Additional handoff notes:");
    expect(prompt).toContain("Prefer cursor for UI work");
    expect(prompt).toContain("pull request already exists");
  });

  it("lists remaining pipeline steps when provided", () => {
    const prompt = renderHandoffPrompt({
      sourceSessionId: "api-1",
      sourceAgent: "claude",
      branch: "api-1",
      worktreePath: "/tmp/worktrees/api/api-1",
      originalPrompt: "Ship feature",
      links: [],
      remainingPipelineSteps: ["run tests", "open PR"],
    });

    expect(prompt).toContain("Remaining pipeline steps:");
    expect(prompt).toContain("1. run tests");
    expect(prompt).toContain("2. open PR");
  });
});
