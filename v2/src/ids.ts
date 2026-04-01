import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const SESSION_HASH_BYTES = 2;
const SESSION_ID_RETRY_LIMIT = 256;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function readLockOwnerPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createLockFile(lockPath: string): void {
  const tempPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${process.pid}\n`, { encoding: "utf-8", flag: "wx" });
  try {
    linkSync(tempPath, lockPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function reapDeadLock(lockPath: string, ownerPid: number): boolean {
  if (isProcessAlive(ownerPid)) {
    return false;
  }

  const stalePath = `${lockPath}.stale.${ownerPid}.${process.pid}.${Date.now()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }

  rmSync(stalePath, { force: true });
  return true;
}

async function withCounterLock<T>(lockPath: string, run: () => T): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      createLockFile(lockPath);
      try {
        return run();
      } finally {
        try {
          if (readLockOwnerPid(lockPath) === process.pid) {
            unlinkSync(lockPath);
          }
        } catch {
          // Best effort cleanup only.
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      const ownerPid = readLockOwnerPid(lockPath);
      if (ownerPid !== null && reapDeadLock(lockPath, ownerPid)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out reserving the next session id for ${lockPath}`, {
          cause: error,
        });
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

function sessionExists(dataDir: string, projectId: string, sessionId: string): boolean {
  return existsSync(join(dataDir, "sessions", projectId, `${sessionId}.json`));
}

function reserveHashedSessionId(dataDir: string, projectId: string, sessionPrefix: string): string {
  for (let attempt = 0; attempt < SESSION_ID_RETRY_LIMIT; attempt += 1) {
    const sessionId = `${sessionPrefix}-${randomBytes(SESSION_HASH_BYTES).toString("hex")}`;
    if (!sessionExists(dataDir, projectId, sessionId)) {
      return sessionId;
    }
  }

  throw new Error(
    `Failed to reserve a unique session id for ${projectId} after ${String(SESSION_ID_RETRY_LIMIT)} attempts`,
  );
}

export async function reserveNextSessionId(
  dataDir: string,
  projectId: string,
  sessionPrefix: string,
): Promise<string> {
  const lockPath = join(dataDir, "counters", `${projectId}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });

  return withCounterLock(lockPath, () => reserveHashedSessionId(dataDir, projectId, sessionPrefix));
}
