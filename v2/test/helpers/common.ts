import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// Resolves symlinks so a symlinked TMPDIR can't smuggle the real target past
// the guards below. A not-yet-existing path can't be a symlink, so fall back
// to a plain (unresolved) absolute path for it and let mkdtemp fail loudly.
function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isEnoent(error)) {
      return resolve(path);
    }
    throw error;
  }
}

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

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep;
}

// true if `a` equals, sits inside, or is an ancestor of `b`. Both arguments
// must already be resolved (realpath'd) — this does no resolution itself.
// The trailing-separator normalization matters at the filesystem root: for
// a === "/", `b.startsWith(a + sep)` tests startsWith("//"), which is always
// false, so the root-as-ancestor case would otherwise never fire.
function isSameOrAncestorOrDescendant(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  return a.startsWith(withTrailingSep(b)) || b.startsWith(withTrailingSep(a));
}

// tracks every dir this process handed out, so a per-file safety net (see
// test/setup/temp-dirs.ts) can sweep up whatever the test itself didn't.
const trackedTempDirs = new Set<string>();

export async function cleanupTrackedTempDirs(): Promise<void> {
  const dirs = [...trackedTempDirs];
  trackedTempDirs.clear();
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      // best-effort cleanup net; report and move on, never throw out of a teardown hook.
      // eslint-disable-next-line no-console
      console.warn(`cleanupTrackedTempDirs: failed to remove ${dir}: ${String(error)}`);
    }
  }
}

export async function createTempDir(prefix: string): Promise<string> {
  const configuredRoot = tmpdir();
  const root = resolveReal(configuredRoot);

  const homeSpurDir = resolveReal(join(homedir(), ".spur"));
  if (isSameOrAncestorOrDescendant(root, homeSpurDir)) {
    throw new Error(
      `Refusing to create a temp dir under TMPDIR=${configuredRoot} (resolved: ${root}): it is ` +
        `inside, equal to, or an ancestor of ${homeSpurDir}. Set TMPDIR to a writable directory ` +
        `outside ~/.spur.`,
    );
  }
  if (hasAncestorProjectConfig(root)) {
    throw new Error(
      `Refusing to create a temp dir under TMPDIR=${configuredRoot} (resolved: ${root}): an ` +
        `ancestor has a spur.yaml/spur.yml. Set TMPDIR to a writable directory outside any ` +
        `spur.yaml tree.`,
    );
  }

  try {
    const dir = await mkdtemp(join(root, prefix));
    trackedTempDirs.add(dir);
    return dir;
  } catch (cause) {
    throw new Error(
      `Failed to create a temp dir under TMPDIR=${configuredRoot} with prefix "${prefix}": ` +
        `${String(cause)}. Set TMPDIR to a writable directory.`,
      { cause },
    );
  }
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
