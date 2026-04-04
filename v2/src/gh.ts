import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}
