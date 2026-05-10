import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentSendMode } from "./agents/index.js";
import { cursorShowsReadyPrompt, cursorShowsWorkspaceTrustPrompt } from "./cursor-state.js";
import { shellEscape } from "./agents/shell-escape.js";
import type { AgentName, SessionSlots } from "./types.js";

// ── Session survival across daemon restarts ──
// The daemon spawns tmux sessions via execFileAsync. By default, systemd
// places child processes in the service's cgroup. If the unit uses the
// default KillMode=control-group, `systemctl restart` sends SIGTERM to
// every process in the cgroup — including tmux and the agents running
// inside it. To prevent this, the systemd unit MUST use KillMode=process
// so only the daemon's node process receives the stop signal.
// After restart, the daemon re-discovers living sessions through
// applyConfig() → resumeSessionDelivery().
// See deploy/spur-daemon.service for the unit template.

const execFileAsync = promisify(execFile);
const TMUX_CONFIG_PATH = fileURLToPath(new URL("../tmux.conf", import.meta.url));
let activeTmuxSocketName: string | null = null;
const CURSOR_TRUST_CONFIRM_DELAY_MS = 1_000;
const CURSOR_TRUST_CONFIRM_MAX_ATTEMPTS = 3;
const CURSOR_READY_SETTLE_DELAY_MS = 1_000;

export function setTmuxSocketName(socketName: string | undefined): void {
  activeTmuxSocketName = socketName?.trim() || null;
}

export function getTmuxSocketName(): string | null {
  return activeTmuxSocketName;
}

export function withTmuxSocketArgs(args: string[]): string[] {
  return activeTmuxSocketName ? ["-L", activeTmuxSocketName, ...args] : args;
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", withTmuxSocketArgs(args));
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

function renderStatusLeft(slots: SessionSlots | undefined): string {
  const title = slots?.title ? truncateStatusText(escapeStatusText(slots.title), 80) : "";
  return title ? `#[bold]${title}#[default]` : "";
}

export async function captureTmuxPane(sessionName: string, lines = 200): Promise<string> {
  const target = exactPaneTarget(sessionName);
  try {
    return await tmux("capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`);
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

export async function isProcessRunningInTmux(
  sessionName: string,
  processMatchers: string[],
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
    const processRes = processMatchers
      .filter((matcher) => matcher.trim().length > 0)
      .map(
        (matcher) =>
          new RegExp(`(?:^|/)${matcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`),
      );
    if (processRes.length === 0) {
      return false;
    }
    for (const line of psOut.split("\n")) {
      const cols = line.trimStart().split(/\s+/);
      if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) {
        continue;
      }
      const args = cols.slice(2).join(" ");
      if (processRes.some((processRe) => processRe.test(args))) {
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
  agent?: AgentName;
  env?: Record<string, string>;
}): Promise<void> {
  const sessionTarget = exactSessionTarget(input.sessionName);
  const envArgs = buildEnvArgs(input.env);

  await execFileAsync("tmux", [
    ...withTmuxSocketArgs([]),
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
    await sendMessageToTmux(input.sessionName, input.launchCommand, {
      ...(input.agent ? { agent: input.agent } : {}),
    });
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
  // `bash` so the exec builtin accepts `VAR=value cmd` assignments (dash rejects them).
  const shellCommand = `bash -lc ${shellEscape(`exec ${input.launchCommand}`)}`;
  await execFileAsync("tmux", [
    ...withTmuxSocketArgs([]),
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
  const statusLeft = renderStatusLeft(slots);
  try {
    await tmux("set-option", "-t", target, "status-left-length", "120");
    await tmux("set-option", "-t", target, "status-left", statusLeft);
    await tmux("set-option", "-t", target, "status", statusLeft ? "on" : "off");
  } catch {
    // Best effort only.
  }
}

async function pasteLiteral(
  sessionName: string,
  payload: string,
  bracketed = false,
): Promise<void> {
  const target = exactPaneTarget(sessionName);
  const bufferName = `spur-${randomUUID()}`;
  const tempPath = join(tmpdir(), `spur-${randomUUID()}.txt`);
  writeFileSync(tempPath, payload, { encoding: "utf-8", mode: 0o600 });
  try {
    await tmux("load-buffer", "-b", bufferName, tempPath);
    const args = ["paste-buffer", "-b", bufferName, "-t", target, "-d"];
    if (bracketed) {
      args.splice(1, 0, "-p");
    }
    await tmux(...args);
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
}

async function sendLiteral(sessionName: string, message: string): Promise<void> {
  const target = exactPaneTarget(sessionName);
  if (message.includes("\n") || message.length > 200) {
    await pasteLiteral(sessionName, message);
    return;
  }

  await tmux("send-keys", "-t", target, "-l", message);
}

const DEFAULT_SUBMIT_DELAY_MS = 300;

export async function sendMessageToTmux(
  sessionName: string,
  message: string,
  options?: { interrupt?: boolean; agent?: AgentName },
): Promise<void> {
  const target = exactPaneTarget(sessionName);
  if (options?.interrupt) {
    await tmux("send-keys", "-t", target, "C-c");
    await sleep(500);
  }
  await tmux("send-keys", "-t", target, "C-u");
  if (options?.agent && agentSendMode(options.agent) === "bracketed_paste") {
    // Codex TUI enables bracketed paste and handles it as a distinct paste event.
    // Submit with a real Enter key so delivery does not depend on newline characters
    // inside the pasted payload or on Codex's paste-burst heuristics.
    await pasteLiteral(sessionName, message, true);
    await tmux("send-keys", "-t", target, "Enter");
    return;
  }
  await sendLiteral(sessionName, message);
  await sleep(DEFAULT_SUBMIT_DELAY_MS);
  await tmux("send-keys", "-t", target, "Enter");
}

export async function sendSubmitKeyToTmux(sessionName: string): Promise<void> {
  const target = exactPaneTarget(sessionName);
  await tmux("send-keys", "-t", target, "Enter");
}

export async function waitForTmuxReady(
  sessionName: string,
  readyMarkers: string[],
  timeoutMs = 30_000,
  options?: { agent?: AgentName },
): Promise<void> {
  if (readyMarkers.length === 0) {
    await sleep(1_500);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let lastCapture = "";
  let lastCursorTrustConfirmAt = 0;
  let cursorTrustConfirmAttempts = 0;
  while (Date.now() < deadline) {
    const capture = await captureTmuxPane(sessionName);
    lastCapture = capture;
    if (options?.agent === "cursor" && cursorShowsReadyPrompt(capture)) {
      if (cursorTrustConfirmAttempts > 0) {
        await sleep(CURSOR_READY_SETTLE_DELAY_MS);
      }
      return;
    }
    if (readyMarkers.every((marker) => capture.includes(marker))) {
      return;
    }
    if (
      options?.agent === "cursor" &&
      cursorShowsWorkspaceTrustPrompt(capture) &&
      cursorTrustConfirmAttempts < CURSOR_TRUST_CONFIRM_MAX_ATTEMPTS &&
      Date.now() - lastCursorTrustConfirmAt >= CURSOR_TRUST_CONFIRM_DELAY_MS
    ) {
      cursorTrustConfirmAttempts += 1;
      lastCursorTrustConfirmAt = Date.now();
      await sendSubmitKeyToTmux(sessionName);
      await sleep(500);
      continue;
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

export function sidecarTmuxSession(sessionId: string, sidecarName: string): string {
  return `${sessionId}--${sidecarName}`;
}

export async function createTmuxSidecarSession(input: {
  sessionId: string;
  sidecarName: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<void> {
  await createTmuxCommandSession({
    sessionName: sidecarTmuxSession(input.sessionId, input.sidecarName),
    cwd: input.cwd,
    launchCommand: input.command,
    ...(input.env ? { env: input.env } : {}),
  });
}

export async function sidecarTmuxAlive(sessionId: string, sidecarName: string): Promise<boolean> {
  return tmuxSessionExists(sidecarTmuxSession(sessionId, sidecarName));
}

export async function killSidecarTmux(sessionId: string, sidecarName: string): Promise<void> {
  await killTmuxSession(sidecarTmuxSession(sessionId, sidecarName));
}
