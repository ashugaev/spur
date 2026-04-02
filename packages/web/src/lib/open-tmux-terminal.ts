import { spawn } from "node:child_process";

export interface OpenTmuxTerminalInput {
  tmuxSession: string;
  worktreePath: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildAttachCommand({ tmuxSession, worktreePath }: OpenTmuxTerminalInput): string {
  return `cd ${shellQuote(worktreePath)} && exec tmux attach-session -t ${shellQuote(`=${tmuxSession}`)}`;
}

function buildAppleScript(command: string): string {
  return [
    'tell application "Terminal"',
    "activate",
    `do script ${JSON.stringify(command)}`,
    "end tell",
    "delay 0.2",
    "try",
    'tell application "System Events"',
    'tell process "Terminal"',
    "set frontmost to true",
    'keystroke "f" using {control down, command down}',
    "end tell",
    "end tell",
    "end try",
  ].join("\n");
}

export async function openTmuxTerminal(input: OpenTmuxTerminalInput): Promise<void> {
  const script = buildAppleScript(buildAttachCommand(input));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
