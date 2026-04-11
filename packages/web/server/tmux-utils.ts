import { execFileSync } from "node:child_process";
import { readSpurInstanceRuntimeConfig } from "./spur-instance.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function tmuxSocketArgs(): string[] {
  const socketName =
    process.env["SPUR_TMUX_SOCKET_NAME"]?.trim() || readSpurInstanceRuntimeConfig().tmuxSocketName;
  return socketName ? ["-L", socketName] : [];
}

export function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function findTmux(execFn: typeof execFileSync = execFileSync): string {
  const candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
  for (const candidate of candidates) {
    try {
      execFn(candidate, [...tmuxSocketArgs(), "-V"], { timeout: 5_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return "tmux";
}

export function tmuxSessionExists(
  tmuxPath: string,
  sessionId: string,
  execFn: typeof execFileSync = execFileSync,
): boolean {
  try {
    execFn(tmuxPath, [...tmuxSocketArgs(), "has-session", "-t", `=${sessionId}`], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
