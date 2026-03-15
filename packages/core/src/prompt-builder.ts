/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. User rules — inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() returns null when there's nothing meaningful to compose
 * (no issue, no rules, no explicit prompt), preserving backward compatibility
 * for bare launches.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig, PipelineStep } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

const BASE_SESSION_PROMPT = `You are an AI agent managed by the Agent Orchestrator. Focus on the assigned task.

## Session Lifecycle
- Your session id is available in $AO_SESSION_ID. A ready-to-use Telegram marker is in $AO_SESSION_MARKER.
- When you finish your work, report the result. The orchestrator will handle routing and notifications.`;

const GIT_WORKFLOW_PROMPT = `## Git Workflow
- Worktree is already created. Don't create a new branch.
- Never commit to the main branch master/dev
- **NEVER force push.** Only regular \`git push\` is allowed.
- To resolve merge conflicts, merge the default branch into your branch (\`git merge\`). Do NOT rebase.
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.
- Do not add any attribution or footer lines to the PR description.
- NEVER change PR status (merge, close, convert to ready, request reviewers) on your own. Only the orchestrator or an explicit human command can trigger status changes.`;

export const BASE_AGENT_PROMPT = `${BASE_SESSION_PROMPT}\n\n${GIT_WORKFLOW_PROMPT}`;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Pre-fetched PR context for continuing work on an existing PR */
  prContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;

  /** Pipeline step context (injected when session has an active pipeline) */
  pipelineStep?: PipelineStep;
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);

  if (project.repo) {
    lines.push(`- Repository: ${project.repo}`);
    lines.push(`- Default branch: ${project.defaultBranch}`);

    if (project.tracker) {
      lines.push(`- Tracker: ${project.tracker.plugin}`);
    }

    const prDraft = project.scm?.prDraft ?? false;
    lines.push(
      prDraft
        ? "- When creating a PR, open it as a **draft** (use --draft flag). Don't change to ready without a clear command."
        : "- When creating a PR, open it as **ready for review** (do NOT use --draft).",
    );
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. ${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  if (config.prContext) {
    lines.push(`\n## PR Context`);
    lines.push(config.prContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PIPELINE STEP CONTEXT
// =============================================================================

export function buildPipelineStepContext(
  step: PipelineStep,
): string {
  const lines: string[] = [];
  lines.push("## Current Pipeline Step");
  lines.push(`**Step:** ${step.id}`);

  if (step.channel) {
    lines.push(step.message ?? step.channel);
    if (step.options && step.options.length > 0) {
      lines.push("");
      lines.push("### Options");
      for (const opt of step.options) {
        lines.push(`- ${opt}`);
      }
    }
    if (step.allowText) {
      lines.push("");
      lines.push("You may also respond with free-form text.");
    }
    lines.push("");
    lines.push("### How to Respond");
    lines.push("- `ao done --output '{\"response\": \"<your-choice>\"}'` -- answer the question");
  } else if (step.run) {
    lines.push(`This step executes: \`${step.run}\``);
  } else {
    lines.push(step.prompt ?? step.message ?? "Waiting for conditions...");
    lines.push("");
    lines.push("### Available Actions");
    lines.push("Use `ao` CLI to signal step completion or ask for help:");
    lines.push('- `ao done [--output \'{"key": "value"}\']` -- mark step as completed');
    lines.push('- `ao fail [--reason "description"]` -- mark step as failed');
    lines.push("- `ao goto <step-id>` -- jump to a specific step");
    lines.push(
      '- `ao ask "<question>" [--options "opt1,opt2"]` -- ask the user a question and wait for response',
    );
  }

  return lines.join("\n");
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Returns null if there's nothing meaningful to compose (no issue, no rules,
 * no explicit user prompt). This preserves backward-compatible behavior where
 * bare launches (no issue) send no prompt.
 */
export function buildPrompt(config: PromptBuildConfig): string | null {
  const hasIssue = Boolean(config.issueId);
  const hasPrContext = Boolean(config.prContext);
  const userRules = readUserRules(config.project);
  const hasRules = Boolean(userRules);
  const hasUserPrompt = Boolean(config.userPrompt);
  const hasPipeline = Boolean(config.pipelineStep);
  const hasRepo = Boolean(config.project.repo);

  // Nothing to compose — return null for backward compatibility
  if (!hasIssue && !hasPrContext && !hasRules && !hasUserPrompt && !hasPipeline) {
    return null;
  }

  const sections: string[] = [];

  // Layer 1: Base session prompt (always)
  sections.push(BASE_SESSION_PROMPT);

  // Git/PR workflow — only for projects with a repo
  if (hasRepo) {
    sections.push(GIT_WORKFLOW_PROMPT);
  }

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Pipeline step context (before user prompt so user prompt can override)
  if (config.pipelineStep) {
    sections.push(buildPipelineStepContext(config.pipelineStep));
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}
