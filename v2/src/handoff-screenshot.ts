import { captureTmuxPane } from "./runtime-tmux.js";
import type { SendMessageAttachment } from "./types.js";

export const HANDOFF_SCREENSHOT_NAME = "handoff-screenshot.txt";
const HANDOFF_SCREENSHOT_LINES = 400;

export async function buildHandoffScreenshotAttachment(
  tmuxSession: string,
): Promise<SendMessageAttachment | null> {
  const pane = await captureTmuxPane(tmuxSession, HANDOFF_SCREENSHOT_LINES);
  if (!pane.trim()) {
    return null;
  }
  return {
    name: HANDOFF_SCREENSHOT_NAME,
    data: Buffer.from(pane, "utf-8").toString("base64"),
  };
}
