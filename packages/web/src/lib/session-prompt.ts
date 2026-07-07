import type { DashboardSession } from "./types";

const SHEPHERD_PROJECT_ID = "spur-shepherd";
const HANDOFF_HEADER_RE = /^Task handoff from session (\S+) \((\w+)\)\./m;
const HANDOFF_NOTES_RE = /Additional handoff notes:\n([\s\S]*)$/;

export interface SessionHandoffView {
  sourceSessionId: string;
  sourceAgent: string;
  notes: string | null;
}

export interface SessionPromptView {
  task: string;
  handoff: SessionHandoffView | null;
  shepherdMode: boolean;
  selfDestructLabel: string | null;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? text.trim();
}

function parseHandoffNotes(prompt: string): string | null {
  const match = prompt.match(HANDOFF_NOTES_RE);
  return match?.[1]?.trim() || null;
}

export function parseSessionPromptView(session: DashboardSession): SessionPromptView {
  const storedTask = session.originalTaskPrompt?.trim() ?? "";
  const prompt = session.prompt.trim();
  const handoffMatch = prompt.match(HANDOFF_HEADER_RE);

  const handoff = handoffMatch
    ? {
        sourceSessionId: handoffMatch[1] ?? "",
        sourceAgent: handoffMatch[2] ?? "",
        notes: parseHandoffNotes(prompt),
      }
    : null;

  const task = storedTask || (handoff ? extractDisplayTaskFromHandoff(prompt) : prompt);
  const shepherdMode =
    session.projectId === SHEPHERD_PROJECT_ID &&
    (prompt.includes("You are Spur Shepherd") || (!handoff && !storedTask));

  const selfDestructLabel = session.selfDestruct?.enabled
    ? session.selfDestruct.conditions?.trim() || "the assigned task is complete"
    : null;

  return {
    task: task.trim(),
    handoff,
    shepherdMode,
    selfDestructLabel,
  };
}

function extractDisplayTaskFromHandoff(prompt: string): string {
  const match = prompt.match(
    /Original task \(as originally requested\):\n([\s\S]*?)(?:\n\n(?:Session title:|Tags:|Links:|Open PR:|Remaining pipeline steps:|A terminal screenshot|Bring the work to production|Additional handoff notes:)|$)/,
  );
  if (!match?.[1]) {
    return firstLine(prompt);
  }
  const candidate = match[1].trim();
  if (candidate.includes("You are Spur Shepherd")) {
    const operator = candidate.match(/Operator request:\n([\s\S]*)$/);
    return operator?.[1]?.trim() || firstLine(candidate);
  }
  return firstLine(candidate);
}

export function getDisplayTaskLine(session: DashboardSession): string {
  const view = parseSessionPromptView(session);
  if (view.task) {
    return firstLine(view.task);
  }
  if (view.handoff) {
    return `Handoff from ${view.handoff.sourceAgent} · ${view.handoff.sourceSessionId}`;
  }
  if (view.shepherdMode) {
    return "Shepherd orchestration";
  }
  return session.id;
}
