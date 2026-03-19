import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
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

export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    accept?: (value: T) => boolean;
  },
): Promise<T> {
  const {
    timeoutMs,
    intervalMs = 250,
    accept = (value) => Boolean(value),
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!accept(last)) {
    if (Date.now() >= deadline) {
      return last;
    }
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}
