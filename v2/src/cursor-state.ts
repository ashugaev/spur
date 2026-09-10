import { CURSOR_READY_MARKERS, CURSOR_RESUME_READY_MARKER } from "./agents/cursor.js";

const CURSOR_ALL_READY_MARKERS = [...CURSOR_READY_MARKERS, CURSOR_RESUME_READY_MARKER] as const;

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
  const readyMarker = lastMatchingMarker(pane, CURSOR_ALL_READY_MARKERS);
  if (!readyMarker) {
    return false;
  }
  const needsInputMarker = lastMatchingMarker(pane, CURSOR_NEEDS_INPUT_MARKERS);
  return !needsInputMarker || readyMarker.index > needsInputMarker.index;
}
