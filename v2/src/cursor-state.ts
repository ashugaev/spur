import { CURSOR_READY_MARKERS } from "./agents/cursor.js";
import type { SessionState } from "./types.js";

const CURSOR_ACTIVITY_HOLD_MS = 15_000;
const CURSOR_WORKSPACE_TRUST_MARKERS = [
  "Workspace Trust Required",
  "Do you trust the contents of this directory?",
  "Trust this workspace",
] as const;
const CURSOR_NEEDS_INPUT_MARKERS = [
  "Press any key to log in",
  ...CURSOR_WORKSPACE_TRUST_MARKERS,
  "Enter to select",
  "Esc to cancel",
  "Choose an option",
];

function lastMatchingMarker(
  pane: string,
  markers: readonly string[],
): { marker: string; index: number } | null {
  let best: { marker: string; index: number } | null = null;
  for (const marker of markers) {
    const index = pane.lastIndexOf(marker);
    if (index === -1) {
      continue;
    }
    if (!best || index > best.index) {
      best = { marker, index };
    }
  }
  return best;
}

export function cursorShowsWorkspaceTrustPrompt(pane: string): boolean {
  const trustMarker = lastMatchingMarker(pane, CURSOR_WORKSPACE_TRUST_MARKERS);
  if (!trustMarker) {
    return false;
  }
  const readyMarker = lastMatchingMarker(pane, CURSOR_READY_MARKERS);
  return !readyMarker || readyMarker.index < trustMarker.index;
}

export function cursorShowsReadyPrompt(pane: string): boolean {
  const readyMarker = lastMatchingMarker(pane, CURSOR_READY_MARKERS);
  if (!readyMarker) {
    return false;
  }
  const needsInputMarker = lastMatchingMarker(pane, CURSOR_NEEDS_INPUT_MARKERS);
  return !needsInputMarker || readyMarker.index > needsInputMarker.index;
}

export function classifyCursorPaneState(args: {
  pane: string;
  activityAt: Date | null;
  now?: number;
}): { state: SessionState; reason: string } {
  const pane = args.pane.trim();
  const needsInputMarker = lastMatchingMarker(pane, CURSOR_NEEDS_INPUT_MARKERS);
  const readyMarker = lastMatchingMarker(pane, CURSOR_READY_MARKERS);
  if (needsInputMarker && (!readyMarker || readyMarker.index < needsInputMarker.index)) {
    return { state: "needs_input", reason: needsInputMarker.marker };
  }

  if (!pane) {
    return { state: "working", reason: "empty pane" };
  }

  const now = args.now ?? Date.now();
  if (args.activityAt && now - args.activityAt.getTime() <= CURSOR_ACTIVITY_HOLD_MS) {
    return { state: "working", reason: "recent pane activity" };
  }

  return { state: "waiting", reason: "idle pane" };
}
