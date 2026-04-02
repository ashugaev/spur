import { execFileSync } from "node:child_process";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function findTmux(execFn: typeof execFileSync = execFileSync): string {
  const candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
  for (const candidate of candidates) {
    try {
      execFn(candidate, ["-V"], { timeout: 5_000 });
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
    execFn(tmuxPath, ["has-session", "-t", `=${sessionId}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
