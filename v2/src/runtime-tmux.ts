import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentName } from "./types.js";

const execFileAsync = promisify(execFile);

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trimEnd();
}

export async function captureTmuxPane(sessionName: string, lines = 200): Promise<string> {
  try {
    return await tmux("capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`);
  } catch {
    return "";
  }
}

export async function getTmuxSessionActivity(sessionName: string): Promise<Date | null> {
  try {
    const output = await tmux("display-message", "-t", sessionName, "-p", "#{session_activity}");
    const seconds = Number.parseInt(output, 10);
    if (Number.isNaN(seconds)) {
      return null;
    }
    return new Date(seconds * 1000);
  } catch {
    return null;
  }
}

export async function isProcessRunningInTmux(
  sessionName: string,
  processName: AgentName,
): Promise<boolean> {
  try {
    const ttyOut = await tmux("list-panes", "-t", sessionName, "-F", "#{pane_tty}");
    const ttys = ttyOut
      .trim()
      .split("\n")
      .map((tty) => tty.trim())
      .filter(Boolean);
    if (ttys.length === 0) {
      return false;
    }

    const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
      timeout: 5_000,
    });
    const ttySet = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")));
    const processRe = new RegExp(`(?:^|/)${processName}(?:\\s|$)`);
    for (const line of psOut.split("\n")) {
      const cols = line.trimStart().split(/\s+/);
      if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) {
        continue;
      }
      const args = cols.slice(2).join(" ");
      if (processRe.test(args)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function createTmuxSession(input: {
  sessionName: string;
  cwd: string;
  launchCommand: string;
  env?: Record<string, string>;
}): Promise<void> {
  const envArgs: string[] = [];
  const sessionEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    ),
    ...(input.env ?? {}),
  };
  for (const [key, value] of Object.entries(sessionEnv)) {
    envArgs.push("-e", `${key}=${value}`);
  }

  await tmux("new-session", "-d", "-s", input.sessionName, "-c", input.cwd, ...envArgs);

  try {
    await sendMessageToTmux(input.sessionName, input.launchCommand);
  } catch (error) {
    try {
      await tmux("kill-session", "-t", input.sessionName);
    } catch {
      // Best effort only.
    }
    throw error;
  }
}

async function sendLiteral(sessionName: string, message: string): Promise<void> {
  if (message.includes("\n") || message.length > 200) {
    const bufferName = `spur-${randomUUID()}`;
    const tempPath = join(tmpdir(), `spur-${randomUUID()}.txt`);
    writeFileSync(tempPath, message, { encoding: "utf-8", mode: 0o600 });
    try {
      await tmux("load-buffer", "-b", bufferName, tempPath);
      await tmux("paste-buffer", "-b", bufferName, "-t", sessionName, "-d");
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failures.
      }
      try {
        await tmux("delete-buffer", "-b", bufferName);
      } catch {
        // Ignore cleanup failures.
      }
    }
    return;
  }

  await tmux("send-keys", "-t", sessionName, "-l", message);
}

export async function sendMessageToTmux(
  sessionName: string,
  message: string,
  options?: { interrupt?: boolean },
): Promise<void> {
  if (options?.interrupt) {
    await tmux("send-keys", "-t", sessionName, "C-c");
    await sleep(500);
  }
  await tmux("send-keys", "-t", sessionName, "C-u");
  await sendLiteral(sessionName, message);
  await sleep(300);
  await tmux("send-keys", "-t", sessionName, "Enter");
}

export async function waitForTmuxReady(
  sessionName: string,
  readyMarkers: string[],
  timeoutMs = 30_000,
): Promise<void> {
  if (readyMarkers.length === 0) {
    await sleep(1_500);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await captureTmuxPane(sessionName);
    if (readyMarkers.every((marker) => capture.includes(marker))) {
      return;
    }
    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for tmux session "${sessionName}" to reach the agent prompt`,
  );
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await tmux("kill-session", "-t", sessionName);
  } catch {
    // Best effort only.
  }
}

export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await tmux("has-session", "-t", sessionName);
    return true;
  } catch {
    return false;
  }
}
