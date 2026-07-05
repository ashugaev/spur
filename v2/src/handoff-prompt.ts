import type { AgentName, SessionLink, SessionPrBinding } from "./types.js";

export interface HandoffPromptContext {
  sourceSessionId: string;
  sourceAgent: AgentName;
  branch: string;
  worktreePath: string;
  originalPrompt: string;
  title?: string;
  links: SessionLink[];
  tags?: string[];
  pr?: SessionPrBinding;
  remainingPipelineSteps?: string[];
  notes?: string;
}

export function renderHandoffPrompt(ctx: HandoffPromptContext): string {
  const lines: string[] = [
    `Task handoff from session ${ctx.sourceSessionId} (${ctx.sourceAgent}).`,
    "",
    "This is not a new task. The previous agent already started it; you are taking it over to finish it.",
    "You continue in the same workspace, branch, and environment as the previous agent.",
    `Branch: ${ctx.branch}`,
    `Workspace: ${ctx.worktreePath}`,
    "",
    "Original task (as originally requested):",
    ctx.originalPrompt,
  ];

  if (ctx.title?.trim()) {
    lines.push("", `Session title: ${ctx.title.trim()}`);
  }

  if (ctx.tags?.length) {
    lines.push("", `Tags: ${ctx.tags.join(", ")}`);
  }

  if (ctx.links.length > 0) {
    lines.push("", "Links:");
    for (const link of ctx.links) {
      lines.push(`- ${link.label}: ${link.url}`);
    }
  }

  if (ctx.pr) {
    lines.push("", `Open PR: ${ctx.pr.url}`);
  }

  if (ctx.remainingPipelineSteps?.length) {
    lines.push("", "Remaining pipeline steps:");
    for (const [index, step] of ctx.remainingPipelineSteps.entries()) {
      lines.push(`${index + 1}. ${step}`);
    }
  }

  lines.push(
    "",
    "Bring the work to production quality: inspect the repo state, run relevant builds and tests, and finish the task end-to-end.",
    "If a pull request already exists, re-check its diff, CI status, and review comments before closing out.",
  );

  if (ctx.notes?.trim()) {
    lines.push("", "Additional handoff notes:", ctx.notes.trim());
  }

  return lines.join("\n");
}
