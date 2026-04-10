import type { DashboardSession } from "@/lib/types";

export type AgentName = DashboardSession["agent"];

export interface AgentHotkey {
  id: string;
  label: string;
  sequence: string;
  shortcut?: string;
  detail: string;
}

function ctrl(char: string): string {
  return String.fromCharCode(char.toUpperCase().charCodeAt(0) - 64);
}

function shortcut(
  id: string,
  label: string,
  shortcutLabel: string,
  sequence: string,
  detail: string,
): AgentHotkey {
  return { id, label, shortcut: shortcutLabel, sequence, detail };
}

function command(id: string, label: string, detail: string): AgentHotkey {
  return {
    id,
    label,
    detail,
    sequence: `${label}\r`,
  };
}

const CLAUDE_HOTKEYS: AgentHotkey[] = [
  shortcut("interrupt", "Interrupt / Back", "Esc", "\x1b", "Stop work or move up one level"),
  shortcut("cycle-mode", "Cycle mode", "Shift+Tab", "\x1b[Z", "Cycle Claude permission mode"),
  shortcut("history", "History search", "Ctrl+R", ctrl("R"), "Search previous prompts"),
  command("compact", "/compact", "Summarize chat and free context"),
  command("clear", "/clear", "Start a fresh Claude chat"),
  command("config", "/config", "Open Claude settings"),
  command("review", "/review", "Run Claude review flow"),
  command("status", "/status", "Show current session status"),
];

const CODEX_HOTKEYS: AgentHotkey[] = [
  shortcut("mention", "Start file picker", "@", "@", "Open the @ mention picker"),
  shortcut("queue", "Queue follow-up", "Tab", "\t", "Queue the current draft while Codex runs"),
  shortcut("clear-screen", "Clear screen", "Ctrl+L", ctrl("L"), "Clear the terminal view"),
  shortcut("interrupt", "Interrupt / Exit", "Ctrl+C", ctrl("C"), "Stop the current run or exit"),
  command("compact", "/compact", "Summarize the visible chat"),
  command("clear", "/clear", "Clear Codex terminal chat"),
  command("copy", "/copy", "Copy the latest completed output"),
  command("status", "/status", "Show session details and IDs"),
  command("plan", "/plan", "Switch to plan mode"),
  command("permissions", "/permissions", "Change approvals in-session"),
];

const HOTKEYS_BY_AGENT: Record<AgentName, AgentHotkey[]> = {
  claude: CLAUDE_HOTKEYS,
  codex: CODEX_HOTKEYS,
};

export function getAgentHotkeys(agent: AgentName): AgentHotkey[] {
  return HOTKEYS_BY_AGENT[agent];
}
