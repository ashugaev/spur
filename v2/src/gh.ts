import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WHICH_PATH = "/usr/bin/which";

type GhPathState =
  | { status: "resolved"; path: string }
  | { status: "unavailable"; message: string };

let cachedGhPathState: GhPathState | null = null;

async function resolveGhPathFromPath(): Promise<GhPathState> {
  try {
    const { stdout } = await execFileAsync(WHICH_PATH, ["gh"], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const path = stdout.trim();
    if (!path.startsWith("/")) {
      return { status: "unavailable", message: "gh not found on PATH" };
    }
    return { status: "resolved", path };
  } catch {
    return { status: "unavailable", message: "gh not found on PATH" };
  }
}

export async function initializeGhPath(): Promise<GhPathState> {
  cachedGhPathState = await resolveGhPathFromPath();
  return cachedGhPathState;
}

async function resolveGhPath(): Promise<string> {
  const state = cachedGhPathState ?? (await initializeGhPath());
  if (state.status === "unavailable") {
    throw new Error(state.message);
  }
  return state.path;
}

export function _resetGhPathCacheForTests(): void {
  cachedGhPathState = null;
}

export function extractGithubErrorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  } else if (typeof error === "string") {
    parts.push(error);
  }
  if (typeof error === "object" && error !== null) {
    if ("stderr" in error && typeof error.stderr === "string") {
      parts.push(error.stderr);
    }
    if ("stdout" in error && typeof error.stdout === "string") {
      parts.push(error.stdout);
    }
    if (!("message" in error) && parts.length === 0) {
      parts.push(String(error));
    }
  }
  return parts.join("\n").trim() || String(error);
}

export function isGitHubRateLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("api rate limit already exceeded") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("secondary rate limit") ||
    (lower.includes("http 403") && lower.includes("rate limit"))
  );
}

export function isDeadWorktreeError(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("not a git repository") || lower.includes("gh cwd does not exist");
}

export async function gh(cwd: string, ...args: string[]): Promise<string> {
  const path = await resolveGhPath();
  try {
    const { stdout } = await execFileAsync(path, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      // ENOENT is ambiguous: execFile throws it for a missing gh binary AND a
      // missing cwd. A transient/removed worktree must not poison the shared
      // path cache and kill the source until restart — fail only this call.
      if (!existsSync(cwd)) {
        throw new Error(`gh cwd does not exist: ${cwd}`, { cause: error });
      }
      cachedGhPathState = {
        status: "unavailable",
        message: `gh unavailable: resolved gh at ${path} is no longer executable; restart Spur daemon after fixing PATH`,
      };
      throw new Error(cachedGhPathState.message, { cause: error });
    }
    throw error;
  }
}
