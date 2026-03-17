import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

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

export async function createTmuxSession(input: {
  sessionName: string;
  cwd: string;
  launchCommand: string;
  env?: Record<string, string>;
}): Promise<void> {
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(input.env ?? {})) {
    envArgs.push("-e", `${key}=${value}`);
  }

  await tmux("new-session", "-d", "-s", input.sessionName, "-c", input.cwd, ...envArgs);

  try {
    await sendLiteral(input.sessionName, input.launchCommand);
    await sleep(300);
    await tmux("send-keys", "-t", input.sessionName, "Enter");
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

export async function sendMessageToTmux(sessionName: string, message: string): Promise<void> {
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
