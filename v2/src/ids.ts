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
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

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

  while (true) {
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
        throw new Error(`Timed out reserving the next session id for ${lockPath}`);
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

export async function reserveNextSessionId(
  dataDir: string,
  projectId: string,
  sessionPrefix: string,
): Promise<string> {
  const counterPath = join(dataDir, "counters", `${projectId}.txt`);
  const lockPath = `${counterPath}.lock`;
  mkdirSync(dirname(counterPath), { recursive: true });

  return withCounterLock(lockPath, () => {
    const current = existsSync(counterPath)
      ? Number.parseInt(readFileSync(counterPath, "utf-8").trim() || "0", 10)
      : 0;
    const next = Number.isFinite(current) ? current + 1 : 1;
    const tmpPath = `${counterPath}.tmp.${process.pid}.${Date.now()}`;

    writeFileSync(tmpPath, `${next}\n`, "utf-8");
    renameSync(tmpPath, counterPath);

    return `${sessionPrefix}-${next}`;
  });
}
