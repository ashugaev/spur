import type { AgentName } from "@/lib/agents";

export interface AgentHotkey {
  id: string;
  label: string;
  sequence: string;
  submit?: boolean;
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
    sequence: label,
    submit: true,
  };
}

const COMMON_HOTKEYS: AgentHotkey[] = [
  shortcut("escape", "Esc", "Esc", "\x1b", "Back out of the current terminal state"),
  shortcut("switch-mode", "Switch mode", "Shift+Tab", "\x1b[Z", "Switch the current work mode"),
];

const TAB_HOTKEY: AgentHotkey = shortcut("tab", "Tab", "Tab", "\t", "Send a Tab key");

const CLAUDE_HOTKEYS: AgentHotkey[] = [
  shortcut(
    "interrupt",
    "Interrupt / Exit",
    "Ctrl+C",
    ctrl("C"),
    "Stop the current run or clear the input",
  ),
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

const CURSOR_HOTKEYS: AgentHotkey[] = [
  shortcut("slash", "Slash", "/", "/", "Start a slash command"),
  shortcut("escape", "Esc", "Esc", "\x1b", "Back out of the current terminal state"),
  shortcut("history", "History search", "Ctrl+R", ctrl("R"), "Search previous prompts"),
  shortcut("clear-screen", "Clear screen", "Ctrl+L", ctrl("L"), "Clear the terminal view"),
  shortcut("interrupt", "Interrupt / Exit", "Ctrl+C", ctrl("C"), "Stop the current run or exit"),
];

const OPENCODE_HOTKEYS: AgentHotkey[] = [
  shortcut("slash", "Slash", "/", "/", "Start a slash command"),
  shortcut("interrupt", "Interrupt / Exit", "Ctrl+C", ctrl("C"), "Stop the current run or exit"),
  command("compact", "/compact", "Summarize chat and free context"),
  command("new", "/new", "Start a new OpenCode session"),
  command("sessions", "/sessions", "Open the session picker"),
];

const HOTKEYS_BY_AGENT: Record<AgentName, AgentHotkey[]> = {
  claude: [...COMMON_HOTKEYS, TAB_HOTKEY, ...CLAUDE_HOTKEYS],
  codex: [...COMMON_HOTKEYS, ...CODEX_HOTKEYS],
  cursor: [...CURSOR_HOTKEYS, TAB_HOTKEY],
  opencode: [...COMMON_HOTKEYS, TAB_HOTKEY, ...OPENCODE_HOTKEYS],
};

export function getAgentHotkeys(agent: AgentName): AgentHotkey[] {
  return HOTKEYS_BY_AGENT[agent];
}
