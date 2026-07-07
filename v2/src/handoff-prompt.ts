import type { AgentName, SessionLink, SessionPrBinding } from "./types.js";
import { HANDOFF_SCREENSHOT_NAME } from "./handoff-screenshot.js";
import { renderShepherdPrompt } from "./shepherd.js";

const SPUR_TRAILING_SECTION_MARKERS = [
  "\n\nSession metadata:",
  "\n\nTask tags:",
  "\n\nSession artifacts:",
  "\n\nBranch naming:",
  "\n\nSidecars:",
  "\n\nSelf-destruct:",
] as const;

const HANDOFF_TASK_STOP_PATTERN =
  "Session title:|Tags:|Links:|Open PR:|Remaining pipeline steps:|A terminal screenshot|Bring the work to production|Additional handoff notes:";

const HANDOFF_TASK_RE = new RegExp(
  `Original task \\(as originally requested\\):\\n([\\s\\S]*?)(?:\\n\\n(?:${HANDOFF_TASK_STOP_PATTERN})|$)`,
);

const SHEPHERD_HEADER = "You are Spur Shepherd:";
const OPERATOR_REQUEST_MARKER = "Operator request:\n";

function stripTrailingSpurSections(text: string): string {
  let end = text.length;
  for (const marker of SPUR_TRAILING_SECTION_MARKERS) {
    const index = text.indexOf(marker);
    if (index !== -1 && index < end) {
      end = index;
    }
  }
  return text.slice(0, end).trimEnd();
}

function peelHandoffTask(text: string): string | null {
  const handoffTaskMatch = text.match(HANDOFF_TASK_RE);
  if (!handoffTaskMatch?.[1]) {
    return null;
  }
  return stripTrailingSpurSections(handoffTaskMatch[1]).trim();
}

function peelShepherdOperatorRequest(text: string): string | null {
  if (!text.includes(SHEPHERD_HEADER)) {
    return null;
  }
  const index = text.lastIndexOf(OPERATOR_REQUEST_MARKER);
  if (index === -1) {
    return null;
  }
  return (
    stripTrailingSpurSections(text.slice(index + OPERATOR_REQUEST_MARKER.length)).trim() || null
  );
}

function peelRestoreTask(text: string): string | null {
  if (!text.startsWith("This session was restored")) {
    return null;
  }
  const restoreTaskMatch = text.match(/Original task:\n\n([\s\S]*)/);
  if (!restoreTaskMatch?.[1]) {
    return null;
  }
  return stripTrailingSpurSections(restoreTaskMatch[1]).trim();
}

function peelPipelineTask(text: string): string | null {
  const pipelineTaskMatch = text.match(
    /\[Spur step \d+\/\d+: [^\]]+\]\n(?:[^\n]+\n\n)?Task:\n([\s\S]*)/,
  );
  if (!pipelineTaskMatch?.[1]) {
    return null;
  }
  return stripTrailingSpurSections(pipelineTaskMatch[1]).trim();
}

export function extractBareUserTask(prompt: string): string {
  let current = prompt.trim();
  if (!current) {
    return current;
  }

  for (let depth = 0; depth < 8; depth++) {
    const handoffTask = peelHandoffTask(current);
    if (handoffTask !== null && handoffTask !== current) {
      current = handoffTask;
      continue;
    }

    const shepherdTask = peelShepherdOperatorRequest(current);
    if (shepherdTask !== null && shepherdTask !== current) {
      current = shepherdTask;
      continue;
    }

    const restoreTask = peelRestoreTask(current);
    if (restoreTask !== null && restoreTask !== current) {
      current = restoreTask;
      continue;
    }

    const pipelineTask = peelPipelineTask(current);
    if (pipelineTask !== null && pipelineTask !== current) {
      current = pipelineTask;
      continue;
    }

    break;
  }

  return stripTrailingSpurSections(current).trim();
}

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
  terminalScreenshot?: boolean;
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

  if (ctx.terminalScreenshot) {
    lines.push(
      "",
      `A terminal screenshot from the source session is attached as ${HANDOFF_SCREENSHOT_NAME}.`,
    );
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

export function isShepherdWrappedPrompt(prompt: string): boolean {
  return prompt.includes(SHEPHERD_HEADER);
}

export function wrapShepherdSpawnPrompt(
  operatorMessage: string | undefined,
  options: { bareSpawnMessage?: boolean },
): string {
  if (options.bareSpawnMessage) {
    return operatorMessage ?? "";
  }
  return renderShepherdPrompt(operatorMessage);
}
