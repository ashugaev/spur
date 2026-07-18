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
import type { AgentName } from "./types.js";

// ── Session survival across daemon restarts ──
// The systemd unit uses KillMode=process, so a daemon restart only stops the
// daemon's node process — this is the actual guarantee that tmux and agents
// survive a restart. `SPUR_TMUX_SYSTEMD_SCOPE=auto` additionally launches new
// tmux sessions through `systemd-run --user --scope` as a best-effort escape
// from spur-daemon.service's cgroup, but that only engages when a per-user
// systemd manager is reachable for the service user (loginctl enable-linger +
// XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS). Without linger provisioned,
// `systemd-run --user` fails and `auto` mode falls back to direct tmux inside
// the daemon cgroup, relying solely on KillMode=process.
// After restart, the daemon re-discovers living sessions through
// applyConfig() → resumeSessionDelivery().
// See deploy/spur-daemon.service for the unit template.

const execFileAsync = promisify(execFile);
const TMUX_CONFIG_PATH = fileURLToPath(new URL("../tmux.conf", import.meta.url));
let activeTmuxSocketName: string | null = null;
const CURSOR_TRUST_CONFIRM_DELAY_MS = 1_000;
const CURSOR_TRUST_CONFIRM_MAX_ATTEMPTS = 3;
const CURSOR_READY_SETTLE_DELAY_MS = 1_000;
const CODEX_READY_SETTLE_DELAY_MS = 500;
// Warn at most once per process lifetime when `auto` mode silently falls back
// to direct tmux, so the log isn't spammed once per session launch.
let warnedSystemdScopeFallback = false;
type SystemdScopeMode = "direct" | "auto" | "required";

function systemdScopeMode(): SystemdScopeMode {
  const value = process.env["SPUR_TMUX_SYSTEMD_SCOPE"]?.trim().toLowerCase();
  if (value === "1") {
    return "required";
  }
  if (value === "auto") {
    return "auto";
  }
  return "direct";
}

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

function isSystemdRunUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const detail = `${message}\n${stderr}`.toLowerCase();
  return (
    detail.includes("failed to connect to bus") ||
    detail.includes("system has not been booted with systemd")
  );
}

// Best-effort out-of-cgroup escape for new tmux sessions. `direct` mode always
// launches tmux inline (inside the daemon cgroup). `auto`/`required` mode
// first tries `systemd-run --user --scope` so the session lives outside
// spur-daemon.service's cgroup; `auto` falls back to direct tmux (with a
// one-time stderr warning) when no per-user systemd manager is available for
// the service user, while `required` propagates the failure. Either way,
// KillMode=process on the daemon unit remains the actual guarantee that a
// daemon restart does not stop the session.
async function runTmuxNewSession(args: string[]): Promise<void> {
  const mode = systemdScopeMode();
  if (mode === "direct") {
    await execFileAsync("tmux", args);
    return;
  }
  try {
    await execFileAsync("systemd-run", [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "tmux",
      ...args,
    ]);
  } catch (error) {
    if (mode === "auto" && isSystemdRunUnavailable(error)) {
      if (!warnedSystemdScopeFallback) {
        warnedSystemdScopeFallback = true;
        process.stderr.write(
          "spur: systemd-run --user is unavailable (no per-user systemd manager for the " +
            "service user — needs `loginctl enable-linger` plus XDG_RUNTIME_DIR/" +
            "DBUS_SESSION_BUS_ADDRESS); falling back to direct tmux inside the daemon " +
            "cgroup. Session survival across daemon restarts now relies solely on " +
            "KillMode=process.\n",
        );
      }
      await execFileAsync("tmux", args);
      return;
    }
    throw error;
  }
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

export async function captureTmuxPane(sessionName: string, lines = 200): Promise<string> {
  const target = exactPaneTarget(sessionName);
  try {
    return await tmux("capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`);
  } catch {
    return "";
  }
}

// Pid of the session's pane process (the shell hosting the agent). Used to
// bind ambiguous agent status files to the process actually in this pane.
export async function getTmuxPanePid(sessionName: string): Promise<number | null> {
  const target = exactPaneTarget(sessionName);
  try {
    const out = await tmux("list-panes", "-t", target, "-F", "#{pane_pid}");
    const first = out.trim().split("\n")[0]?.trim();
    const pid = Number.parseInt(first ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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

  await runTmuxNewSession([
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
  const paneTarget = exactPaneTarget(input.sessionName);
  // Wrap in `sh -lc` without `exec` so shell builtins (cd, set, export, ...)
  // in the project's sidecar command work. With `exec`, sh tries to exec the
  // first token as a binary and a builtin-led command like `cd front && ...`
  // dies instantly with "exec: cd: not found".
  const shellCommand = `sh -lc ${shellEscape(input.launchCommand)}`;

  // Two-step launch so `remain-on-exit on` is set BEFORE the user command
  // runs. If we pass the shell-command directly to `new-session`, a command
  // that crashes on first line (bad PATH, missing binary, exec-on-builtin)
  // tears the pane down before the pane option can land — making the failure
  // invisible. `remain-on-exit` is a pane option, so set it with `-p` on the
  // pane we are about to respawn.
  await runTmuxNewSession([
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
  ]);
  await tmux("set-option", "-p", "-t", paneTarget, "remain-on-exit", "on");
  await tmux("respawn-pane", "-k", "-t", paneTarget, shellCommand);
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
  const useBracketedPaste =
    options?.agent !== undefined &&
    agentSendMode(options.agent) === "bracketed_paste" &&
    !process.env["SPUR_SKIP_CODEX_SUBMIT_ACK"];
  if (options?.interrupt) {
    await tmux("send-keys", "-t", target, "C-c");
    await sleep(500);
  }
  // Exit copy-mode before issuing line-edit keys. `-X cancel` is a no-op
  // outside copy-mode; if a user accidentally entered it (mouse drag, PageUp),
  // C-u and Enter would otherwise be interpreted by the copy buffer and never
  // reach the agent's stdin. Older tmux builds may exit non-zero here — swallow.
  await tmux("send-keys", "-t", target, "-X", "cancel").catch(() => {});
  await tmux("send-keys", "-t", target, "C-u");
  if (useBracketedPaste) {
    // Codex TUI enables bracketed paste and handles it as a distinct paste event.
    // The bash-based fake Codex runtime used in tests does not, so keep those
    // runs on plain tmux input to avoid losing the first resumed prompt send.
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
      if (options?.agent === "codex") {
        // Codex can print its prompt before the next stdin read is ready.
        await sleep(CODEX_READY_SETTLE_DELAY_MS);
      }
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
