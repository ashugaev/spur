import { execFile } from "node:child_process";
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
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      cachedGhPathState = {
        status: "unavailable",
        message: `gh unavailable: resolved gh at ${path} is no longer executable; restart Spur daemon after fixing PATH`,
      };
      throw new Error(cachedGhPathState.message, { cause: error });
    }
    throw error;
  }
}
