import { describe, expect, it } from "vitest";
import { buildAgentSwitchPrompt } from "../../src/agent-switch-prompt.js";

describe("buildAgentSwitchPrompt", () => {
  it("renders source session, environment, task, links, and mandate", () => {
    const prompt = buildAgentSwitchPrompt(
      {
        id: "spur-90ed",
        project: "sp",
        agent: "codex",
        agentSessionId: "agent-runtime-42",
        model: "gpt-5.3-codex",
        prompt: "Add agent switch button",
        branch: "feature/agent-switch",
        worktree: true,
        worktreePath: "/home/user/.spur/worktrees/sp/spur-90ed",
        slots: {
          title: "Agent switch button",
          links: [
            { label: "tracker", url: "https://example.com/t/1" },
            { label: "pr", url: "https://github.com/org/repo/pull/12" },
          ],
          tags: ["feature"],
        },
      },
      "Focus on packages/web first.",
    );

    expect(prompt).toContain("Spur session ID: spur-90ed");
    expect(prompt).toContain("Prior agent runtime session ID: agent-runtime-42");
    expect(prompt).toContain("Prior agent: codex");
    expect(prompt).toContain("Branch: feature/agent-switch");
    expect(prompt).toContain("Add agent switch button");
    expect(prompt).toContain("tracker: https://example.com/t/1");
    expect(prompt).toContain("pr: https://github.com/org/repo/pull/12");
    expect(prompt).toContain("Re-verify CI");
    expect(prompt).toContain("Carry this task through to production");
    expect(prompt).toContain("Focus on packages/web first.");
  });

  it("omits optional sections when absent", () => {
    const prompt = buildAgentSwitchPrompt({
      id: "spur-a1",
      project: "demo",
      agent: "claude",
      prompt: "Ship fix",
      branch: "main",
      worktree: false,
      worktreePath: "/repo/demo",
    });

    expect(prompt).not.toContain("Prior agent runtime session ID");
    expect(prompt).not.toContain("## Pull requests");
    expect(prompt).not.toContain("## Additional context from handoff");
    expect(prompt).toContain("shared checkout");
  });
});
