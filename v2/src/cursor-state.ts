import type { SessionState } from "./types.js";

const CURSOR_ACTIVITY_HOLD_MS = 15_000;
const CURSOR_NEEDS_INPUT_MARKERS = [
  "Press any key to log in",
  "Workspace Trust Required",
  "Do you trust the contents of this directory?",
  "Trust this workspace",
  "Enter to select",
  "Esc to cancel",
  "Choose an option",
];

export function classifyCursorPaneState(args: {
  pane: string;
  activityAt: Date | null;
  now?: number;
}): { state: SessionState; reason: string } {
  const pane = args.pane.trim();
  for (const marker of CURSOR_NEEDS_INPUT_MARKERS) {
    if (pane.includes(marker)) {
      return { state: "needs_input", reason: marker };
    }
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
