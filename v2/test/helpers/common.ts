import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

function hasAncestorProjectConfig(startDir: string): boolean {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, "spur.yaml")) || existsSync(join(current, "spur.yml"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function tempRootCandidates(): string[] {
  const roots = [tmpdir(), "/var/tmp"];
  let current = dirname(process.cwd());
  for (;;) {
    if (!roots.includes(current)) {
      roots.push(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

async function createTempDirInRoot(root: string, prefix: string): Promise<string | undefined> {
  try {
    await access(root, constants.W_OK);
    return await mkdtemp(join(root, prefix));
  } catch {
    return undefined;
  }
}

export async function createTempDir(prefix: string): Promise<string> {
  for (const root of tempRootCandidates()) {
    const dir = await createTempDirInRoot(root, prefix);
    if (!dir) {
      continue;
    }
    if (!hasAncestorProjectConfig(dir)) {
      return dir;
    }
    await rm(dir, { recursive: true, force: true });
  }

  throw new Error("Failed to create temp dir without ancestor spur.yaml or spur.yml");
}

export async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Failed to allocate a test port"));
        });
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    accept?: (value: T) => boolean;
    label?: string;
  },
): Promise<T> {
  const {
    timeoutMs,
    intervalMs = 250,
    accept = (value) => Boolean(value),
    label = "condition",
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!accept(last)) {
    if (Date.now() >= deadline) {
      let serialized: string;
      try {
        serialized = JSON.stringify(last);
      } catch {
        serialized = String(last);
      }
      throw new Error(
        `pollUntil timed out after ${timeoutMs}ms waiting for ${label}; last value: ${serialized}`,
      );
    }
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}
