import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedGhPath: string | null = null;

async function resolveGhPath(): Promise<string> {
  if (cachedGhPath !== null) return cachedGhPath;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "gh");
    try {
      await access(candidate, constants.X_OK);
      cachedGhPath = candidate;
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error("gh not found on PATH");
}

export function _resetGhPathCacheForTests(): void {
  cachedGhPath = null;
}

export async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(await resolveGhPath(), args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}
