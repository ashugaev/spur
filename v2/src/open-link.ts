import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => Pick<ChildProcess, "unref">;

function defaultOpeners(): string[] {
  return process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview"];
}

export function openExternalUrl(
  url: string,
  options?: {
    openers?: string[];
    spawnProcess?: SpawnLike;
  },
): boolean {
  const openers = options?.openers ?? defaultOpeners();
  const spawnProcess = options?.spawnProcess ?? spawn;
  for (const opener of openers) {
    try {
      const child = spawnProcess(opener, [url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return false;
}

export function runOpenLinkCli(argv = process.argv): number {
  const url = argv[2];
  if (!url) {
    return 1;
  }
  return openExternalUrl(url) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runOpenLinkCli();
}
