import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { shellEscape } from "./agents/shell-escape.js";
import type { AgentName, SessionSlots } from "./types.js";

const execFileAsync = promisify(execFile);
const TMUX_CONFIG_PATH = fileURLToPath(new URL("../tmux.conf", import.meta.url));

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trimEnd();
}

function buildEnvArgs(env?: Record<string, string>): string[] {
  const envArgs: string[] = [];
  const sessionEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    ),
    ...(env ?? {}),
  };
  for (const [key, value] of Object.entries(sessionEnv)) {
    envArgs.push("-e", `${key}=${value}`);
  }
  return envArgs;
}

function exactSessionTarget(sessionName: string): string {
  return `=${sessionName}`;
}

function exactPaneTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

function escapeStatusText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/#/g, "##");
}

function truncateStatusText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function escapeHyperlinkUrl(url: string): string {
  return encodeURI(url).replaceAll("#", "%23").replaceAll(",", "%2C").replaceAll("]", "%5D");
}

function renderStatusLeft(sessionName: string, slots: SessionSlots | undefined): string {
  const title = slots?.title ? truncateStatusText(escapeStatusText(slots.title), 80) : "";
  return title
    ? `#[bold]${escapeStatusText(sessionName)}#[default] | ${title}`
    : `#[bold]${escapeStatusText(sessionName)}#[default]`;
}

function renderStatusRight(slots: SessionSlots | undefined): string {
  const links = slots?.links ?? [];
  return links
    .map((link) => {
      const label = truncateStatusText(escapeStatusText(link.label), 18);
      const url = escapeHyperlinkUrl(link.url);
      return `#[fg=cyan]#[hyperlink=${url}]${label}#[hyperlink=]#[default]`;
    })
    .join(" | ");
}

export async function captureTmuxPane(sessionName: string, lines = 200): Promise<string> {
  const target = exactPaneTarget(sessionName);
  try {
    return await tmux("capture-pane", "-t", target, "-p", "-S", `-${lines}`);
  } catch {
    return "";
  }
}

export async function getTmuxSessionActivity(sessionName: string): Promise<Date | null> {
  const target = exactPaneTarget(sessionName);
  try {
    const output = await tmux("display-message", "-t", target, "-p", "#{session_activity}");
    const seconds = Number.parseInt(output, 10);
    if (Number.isNaN(seconds)) {
      return null;
    }
    return new Date(seconds * 1000);
  } catch {
    return null;
  }
}

export async function getTmuxPaneTitle(sessionName: string): Promise<string> {
  const target = exactPaneTarget(sessionName);
  try {
    return await tmux("display-message", "-t", target, "-p", "#{pane_title}");
  } catch {
    return "";
  }
}

export async function isProcessRunningInTmux(
  sessionName: string,
  processName: AgentName,
): Promise<boolean> {
  const target = exactSessionTarget(sessionName);
  try {
    const ttyOut = await tmux("list-panes", "-t", target, "-F", "#{pane_tty}");
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
  const sessionTarget = exactSessionTarget(input.sessionName);
  const envArgs = buildEnvArgs(input.env);

  await execFileAsync("tmux", [
    "-f",
    TMUX_CONFIG_PATH,
    "new-session",
    "-d",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    ...envArgs,
  ]);
  await sleep(300);

  try {
    await sendMessageToTmux(input.sessionName, input.launchCommand);
  } catch (error) {
    try {
      await tmux("kill-session", "-t", sessionTarget);
    } catch {
      // Best effort only.
    }
    throw error;
  }
}

export async function createTmuxCommandSession(input: {
  sessionName: string;
  cwd: string;
  launchCommand: string;
  env?: Record<string, string>;
}): Promise<void> {
  const sessionTarget = exactSessionTarget(input.sessionName);
  const shellCommand = `sh -lc ${shellEscape(`exec ${input.launchCommand}`)}`;
  await execFileAsync("tmux", [
    "-f",
    TMUX_CONFIG_PATH,
    "new-session",
    "-d",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    ...buildEnvArgs(input.env),
    shellCommand,
  ]);
  await sleep(100);
  try {
    await tmux("set-option", "-t", sessionTarget, "remain-on-exit", "on");
  } catch {
    // Best effort only. The service session is already live at this point.
  }
}

export async function syncTmuxStatus(sessionName: string, slots?: SessionSlots): Promise<void> {
  const target = exactPaneTarget(sessionName);
  try {
    await tmux("set-option", "-t", target, "status", "on");
    await tmux("set-option", "-t", target, "status-left-length", "120");
    await tmux("set-option", "-t", target, "status-right-length", "160");
    await tmux("set-option", "-t", target, "status-left", renderStatusLeft(sessionName, slots));
    await tmux("set-option", "-t", target, "status-right", renderStatusRight(slots));
  } catch {
    // Best effort only.
  }
}

async function sendLiteral(sessionName: string, message: string): Promise<void> {
  const target = exactPaneTarget(sessionName);
  if (message.includes("\n") || message.length > 200) {
    const bufferName = `spur-${randomUUID()}`;
    const tempPath = join(tmpdir(), `spur-${randomUUID()}.txt`);
    writeFileSync(tempPath, message, { encoding: "utf-8", mode: 0o600 });
    try {
      await tmux("load-buffer", "-b", bufferName, tempPath);
      await tmux("paste-buffer", "-b", bufferName, "-t", target, "-d");
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

  await tmux("send-keys", "-t", target, "-l", message);
}

export async function sendMessageToTmux(
  sessionName: string,
  message: string,
  options?: { interrupt?: boolean },
): Promise<void> {
  const target = exactPaneTarget(sessionName);
  if (options?.interrupt) {
    await tmux("send-keys", "-t", target, "C-c");
    await sleep(500);
  }
  await tmux("send-keys", "-t", target, "C-u");
  await sendLiteral(sessionName, message);
  await sleep(300);
  await tmux("send-keys", "-t", target, "Enter");
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
  let lastCapture = "";
  while (Date.now() < deadline) {
    const capture = await captureTmuxPane(sessionName);
    lastCapture = capture;
    if (readyMarkers.every((marker) => capture.includes(marker))) {
      return;
    }
    await sleep(500);
  }

  const detail = lastCapture.trim()
    ? `\nLast pane output:\n${lastCapture.trimEnd().split("\n").slice(-40).join("\n")}`
    : "";
  throw new Error(
    `Timed out waiting for tmux session "${sessionName}" to reach the agent prompt${detail}`,
  );
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  const target = exactSessionTarget(sessionName);
  try {
    await tmux("kill-session", "-t", target);
  } catch {
    // Best effort only.
  }
}

export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  const target = exactSessionTarget(sessionName);
  try {
    await tmux("has-session", "-t", target);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxPaneDead(sessionName: string): Promise<boolean> {
  const target = exactPaneTarget(sessionName);
  try {
    const output = await tmux("display-message", "-t", target, "-p", "#{pane_dead}");
    return output.trim() === "1";
  } catch {
    return true;
  }
}

export function devServerTmuxSession(sessionId: string): string {
  return `${sessionId}--dev`;
}

export async function createTmuxDevServerSession(input: {
  sessionId: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<void> {
  await createTmuxCommandSession({
    sessionName: devServerTmuxSession(input.sessionId),
    cwd: input.cwd,
    launchCommand: input.command,
    ...(input.env ? { env: input.env } : {}),
  });
}

export async function devServerTmuxAlive(sessionId: string): Promise<boolean> {
  return tmuxSessionExists(devServerTmuxSession(sessionId));
}

export async function killDevServerTmux(sessionId: string): Promise<void> {
  await killTmuxSession(devServerTmuxSession(sessionId));
}
