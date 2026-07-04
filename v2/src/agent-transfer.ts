import type { SessionRecord } from "./types.js";

export function buildTransferHandoffPrompt(session: SessionRecord, note?: string): string {
  const lines: string[] = [
    "You are taking over a task from another Spur agent session.",
    "",
    "## Handoff",
    `- Previous session: ${session.id}`,
    `- Previous agent: ${session.agent}${session.model ? ` (${session.model})` : ""}`,
    `- Project: ${session.project}`,
    `- Branch: ${session.branch}`,
  ];

  if (session.worktree) {
    lines.push(`- Workspace: same worktree as the previous session`);
  }

  lines.push("", "## Original task", session.prompt.trim());

  const links = session.slots?.links ?? [];
  if (links.length > 0) {
    lines.push("", "## Links");
    for (const link of links) {
      lines.push(`- ${link.label}: ${link.url}`);
    }
  }

  const tags = session.slots?.tags ?? [];
  if (tags.length > 0) {
    lines.push("", "## Tags", tags.join(", "));
  }

  if (session.pr) {
    lines.push(
      "",
      "## Pull request",
      `- ${session.pr.url} (${session.pr.repo}#${session.pr.number})`,
    );
  }

  if (session.pipeline?.steps.length) {
    lines.push("", "## Pipeline");
    const nextIndex = session.pipeline.nextStepIndex;
    for (let index = 0; index < session.pipeline.steps.length; index += 1) {
      const step = session.pipeline.steps[index];
      const marker = index < nextIndex ? "[done]" : index === nextIndex ? "[current]" : "[pending]";
      lines.push(`- ${marker} ${step}`);
    }
  }

  lines.push(
    "",
    "## Instructions",
    "- You are in the same environment, branch, and worktree as the previous agent.",
    "- Continue the work through to production-ready completion.",
    "- Review any linked pull requests, CI state, and existing changes before proceeding.",
    "- Verify the repository is in good shape: uncommitted work, open PRs, and branch health.",
    "- Use the strongest available model when model choice is available.",
  );

  const trimmedNote = note?.trim();
  if (trimmedNote) {
    lines.push("", "## Additional context from user", trimmedNote);
  }

  return lines.join("\n");
}
