import { DEFAULT_SELF_DESTRUCT_CONDITION } from "./self-destruct";
import type { DashboardSession } from "./types";

const HANDOFF_HEADER_RE = /^Task handoff from session (\S+) \((\w+)\)\./m;
const HANDOFF_NOTES_RE = /Additional handoff notes:\n([\s\S]*)$/;
const SHEPHERD_HEADER = "You are Spur Shepherd:";
const OPERATOR_REQUEST_MARKER = "Operator request:\n";
export const TELEGRAM_REPLY_SUFFIX = [
  "",
  "",
  "Source: telegram. The requester only sees messages you send with:",
  'spur source reply "<message>"',
  'Offer choices with `--button <label>` or `--button <label>=<value>`, repeatable: spur source reply "Deploy now?" --button "Yes" --button "Later=wait for me". A click arrives as an ordinary user message carrying the value.',
  "Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.",
].join("\n");
const BOOTSTRAP_GOAL =
  "Goal: write a spur.yaml at the project root that registers this project, then ask Spur to connect it.";
const BOOTSTRAP_HEADER_PREFIX = 'You are configuring a new Spur project named "';
const BOOTSTRAP_HEADER_BOUNDARY = '".\n\nInputs (do not change these values):\n';
const BOOTSTRAP_CONSTRAINTS = [
  "Constraints:",
  "- Do not modify any file other than spur.yaml.",
  "- Do not run package managers, build tools, or tests.",
  "- Do not create branches, commits, or pushes.",
  "- Keep total output under 40 lines.",
] as const;
const SPUR_TRAILING_SECTION_MARKERS = [
  "\n\nSession metadata:",
  "\n\nTask tags:",
  "\n\nSession artifacts:",
  "\n\nBranch naming:",
  "\n\nSidecars:",
] as const;

export interface SessionHandoffView {
  sourceSessionId: string;
  sourceAgent: string;
  notes: string | null;
}

export interface SessionPromptView {
  task: string;
  handoff: SessionHandoffView | null;
  selfDestructLabel: string | null;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? text.trim();
}

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

// Anchored on the wrapper's first and last line instead of the whole constant:
// prompts stored before a wording change must keep stripping. Still requires the
// wrapper to be trailing, so a prompt quoting it mid-text stays intact.
const TELEGRAM_REPLY_SUFFIX_RE =
  /\n\nSource: telegram\. The requester only sees messages you send with:\n[\s\S]*Your terminal output is invisible to them\.[^\n]*$/;

function stripTelegramReplySuffix(text: string): string {
  return text.replace(TELEGRAM_REPLY_SUFFIX_RE, "").trimEnd();
}

export function isGeneratedBootstrapPrompt(text: string): boolean {
  if (!text.startsWith(BOOTSTRAP_HEADER_PREFIX)) {
    return false;
  }

  let boundaryIndex = text.indexOf(BOOTSTRAP_HEADER_BOUNDARY, BOOTSTRAP_HEADER_PREFIX.length);
  while (boundaryIndex !== -1) {
    const displayName = text.slice(BOOTSTRAP_HEADER_PREFIX.length, boundaryIndex);
    const lines = text.slice(boundaryIndex + BOOTSTRAP_HEADER_BOUNDARY.length).split("\n");
    const constraintsIndex = lines.lastIndexOf(BOOTSTRAP_CONSTRAINTS[0]);
    if (
      displayName.trim() !== "" &&
      /^- project id: .+$/.test(lines[0] ?? "") &&
      /^- sessionPrefix: .+$/.test(lines[1] ?? "") &&
      /^- project path: .+$/.test(lines[2] ?? "") &&
      lines[3] === "" &&
      lines[4] === BOOTSTRAP_GOAL &&
      lines[5] === "" &&
      lines[6] === "Steps:" &&
      constraintsIndex !== -1 &&
      constraintsIndex + BOOTSTRAP_CONSTRAINTS.length === lines.length &&
      BOOTSTRAP_CONSTRAINTS.every(
        (constraint, offset) => lines[constraintsIndex + offset] === constraint,
      )
    ) {
      return true;
    }
    boundaryIndex = text.indexOf(BOOTSTRAP_HEADER_BOUNDARY, boundaryIndex + 1);
  }

  return false;
}

function canonicalizeTask(text: string): string {
  const trimmed = text.trim();
  return stripTelegramReplySuffix(trimmed);
}

function parseHandoffNotes(prompt: string): string | null {
  const match = prompt.match(HANDOFF_NOTES_RE);
  return match?.[1]?.trim() || null;
}

function extractShepherdOperatorRequest(prompt: string): string | null {
  if (!prompt.includes(SHEPHERD_HEADER)) {
    return null;
  }
  const index = prompt.lastIndexOf(OPERATOR_REQUEST_MARKER);
  if (index === -1) {
    return null;
  }
  return (
    stripTrailingSpurSections(prompt.slice(index + OPERATOR_REQUEST_MARKER.length)).trim() || null
  );
}

function extractDisplayTaskFromHandoff(prompt: string): string {
  const match = prompt.match(
    /Original task \(as originally requested\):\n([\s\S]*?)(?:\n\n(?:Session title:|Tags:|Links:|Open PR:|Remaining pipeline steps:|A terminal screenshot|Bring the work to production|Additional handoff notes:)|$)/,
  );
  if (!match?.[1]) {
    return firstLine(prompt);
  }
  const candidate = stripTrailingSpurSections(match[1]).trim();
  return extractShepherdOperatorRequest(candidate) ?? candidate;
}

function resolveDisplayTask(session: DashboardSession, prompt: string): string {
  const storedTask = session.originalTaskPrompt?.trim();
  if (storedTask) {
    return canonicalizeTask(storedTask);
  }

  if (HANDOFF_HEADER_RE.test(prompt)) {
    return canonicalizeTask(extractDisplayTaskFromHandoff(prompt));
  }

  const shepherdTask = extractShepherdOperatorRequest(prompt);
  if (shepherdTask) {
    return canonicalizeTask(shepherdTask);
  }

  return canonicalizeTask(stripTrailingSpurSections(prompt));
}

export function parseSessionPromptView(session: DashboardSession): SessionPromptView {
  const prompt = session.prompt.trim();
  const handoffMatch = prompt.match(HANDOFF_HEADER_RE);

  const handoff = handoffMatch
    ? {
        sourceSessionId: handoffMatch[1] ?? "",
        sourceAgent: handoffMatch[2] ?? "",
        notes: parseHandoffNotes(prompt),
      }
    : null;

  const selfDestructLabel = session.selfDestruct?.enabled
    ? session.selfDestruct.conditions?.trim() || DEFAULT_SELF_DESTRUCT_CONDITION
    : null;

  return {
    task: resolveDisplayTask(session, prompt),
    handoff,
    selfDestructLabel,
  };
}

export function getDisplayTaskLine(session: DashboardSession): string {
  const view = parseSessionPromptView(session);
  if (view.task) {
    return firstLine(view.task);
  }
  if (view.handoff) {
    return `Handoff from ${view.handoff.sourceAgent} · ${view.handoff.sourceSessionId}`;
  }
  return session.id;
}
