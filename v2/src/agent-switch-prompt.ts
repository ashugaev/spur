import type { SessionLink, SessionRecord } from "./types.js";

export interface AgentSwitchPromptSource {
  id: string;
  project: string;
  agent: string;
  agentSessionId?: string;
  model?: string;
  prompt: string;
  branch: string;
  worktree: boolean;
  worktreePath: string;
  pr?: SessionRecord["pr"];
  slots?: SessionRecord["slots"];
}

export function buildAgentSwitchPrompt(
  source: AgentSwitchPromptSource,
  additionalNotes?: string,
): string {
  const lines: string[] = [];

  lines.push("You are continuing work handed off from another Spur agent session.");
  lines.push("");
  lines.push("## Source session");
  lines.push(`- Spur session ID: ${source.id}`);
  if (source.agentSessionId?.trim()) {
    lines.push(`- Prior agent runtime session ID: ${source.agentSessionId.trim()}`);
  }
  lines.push(`- Prior agent: ${source.agent}`);
  if (source.model?.trim()) {
    lines.push(`- Prior model: ${source.model.trim()}`);
  }
  lines.push("");
  lines.push("## Environment");
  lines.push(`- Project: ${source.project}`);
  lines.push(`- Branch: ${source.branch}`);
  lines.push(`- Workspace: ${source.worktreePath}`);
  lines.push(`- Worktree mode: ${source.worktree ? "yes" : "shared checkout"}`);
  lines.push(
    "- You are in the same environment, same branch, and same checkout as the prior agent.",
  );
  lines.push("");

  const title = source.slots?.title?.trim();
  if (title) {
    lines.push("## Task title");
    lines.push(title);
    lines.push("");
  }

  lines.push("## Original task");
  lines.push(source.prompt.trim());
  lines.push("");

  const links = source.slots?.links ?? [];
  if (links.length > 0) {
    lines.push("## Links and metadata");
    for (const link of links) {
      lines.push(`- ${formatLinkLine(link)}`);
    }
    lines.push("");
  }

  const tags = source.slots?.tags ?? [];
  if (tags.length > 0) {
    lines.push("## Tags");
    lines.push(tags.join(", "));
    lines.push("");
  }

  if (hasLinkedPullRequest(source, links)) {
    lines.push("## Pull requests");
    lines.push(
      "This session has linked pull request(s). Re-verify CI, review comments, and merge readiness. Fix anything not in good shape before calling the work done.",
    );
    lines.push("");
  }

  lines.push("## Your mandate");
  lines.push(
    "Carry this task through to production: finish implementation, validate locally, ensure PRs are healthy, and close out per project workflow.",
  );
  lines.push("");

  const notes = additionalNotes?.trim();
  if (notes) {
    lines.push("## Additional context from handoff");
    lines.push(notes);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatLinkLine(link: SessionLink): string {
  return `${link.label}: ${link.url}`;
}

function hasLinkedPullRequest(
  source: AgentSwitchPromptSource,
  links: readonly SessionLink[],
): boolean {
  if (source.pr) {
    return true;
  }
  return links.some(
    (link) => link.label === "pr" || link.label === "github-pr" || link.label === "gitlab-pr",
  );
}
