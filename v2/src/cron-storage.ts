import { randomBytes } from "node:crypto";
import {
  type Stats,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PROJECT_ID_PATTERN } from "./config.js";
import {
  listArtifactsInDir,
  readArtifactInDir,
  type SessionArtifactFile,
} from "./session-artifacts.js";
import type { CronSpawnOrigin, CronStorageView } from "./types.js";

const CRON_STORAGE_ROOT = "cron-storage";
const CRON_STORAGE_NOTE = "note.md";
const NOTE_TEMP_RE = /^\.note-[0-9a-f]{16}\.tmp$/;

/** A storage level exists but is a symlink or not a directory. */
export class CronStorageRootError extends Error {
  constructor(path: string) {
    super(`Cron storage path is not a real directory: ${path}`);
    this.name = "CronStorageRootError";
  }
}

export function isCronSpawnOrigin(value: unknown): value is CronSpawnOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return [candidate.projectId, candidate.sourceId, candidate.triggerId].every(
    (id) => typeof id === "string" && PROJECT_ID_PATTERN.test(id),
  );
}

function storageLevels(
  dataDir: string,
  projectId: string,
  triggerId: string,
): [string, string, string] {
  for (const id of [projectId, triggerId]) {
    if (!PROJECT_ID_PATTERN.test(id)) {
      throw new Error(`Invalid cron storage id: ${JSON.stringify(id)}`);
    }
  }
  const top = join(dataDir, CRON_STORAGE_ROOT);
  const project = join(top, projectId);
  return [top, project, join(project, triggerId)];
}

/** <dataDir>/cron-storage/<projectId>/<triggerId>. Throws on an id outside PROJECT_ID_PATTERN. */
export function cronStorageDir(dataDir: string, projectId: string, triggerId: string): string {
  return storageLevels(dataDir, projectId, triggerId)[2];
}

function lstatLevel(path: string): Stats | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CronStorageRootError(path);
  }
  return stat;
}

/**
 * Lstats the three storage levels top-down. Returns false when one is missing; throws
 * CronStorageRootError when one is a symlink or not a directory.
 */
export function assertCronStorageRoot(
  dataDir: string,
  projectId: string,
  triggerId: string,
): boolean {
  for (const level of storageLevels(dataDir, projectId, triggerId)) {
    if (lstatLevel(level) === null) {
      return false;
    }
  }
  return true;
}

/**
 * Creates the storage dir one level at a time, refusing a symlinked or non-directory level
 * before descending, so nothing is ever created outside dataDir. Returns the dir path.
 */
export function ensureCronStorageDir(
  dataDir: string,
  projectId: string,
  triggerId: string,
): string {
  const levels = storageLevels(dataDir, projectId, triggerId);
  for (const level of levels) {
    if (lstatLevel(level) !== null) {
      continue;
    }
    try {
      mkdirSync(level);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (lstatLevel(level) === null) {
      throw new CronStorageRootError(level);
    }
  }
  return levels[2];
}

function emptyView(): CronStorageView {
  return {
    note: "",
    noteUpdatedAt: null,
    files: [],
    totalBytes: 0,
    updatedAt: null,
    truncated: false,
  };
}

/** null when note.md vanished between the stat and the read. */
function readNote(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function readCronStorage(
  dataDir: string,
  projectId: string,
  triggerId: string,
): CronStorageView {
  if (!assertCronStorageRoot(dataDir, projectId, triggerId)) {
    return emptyView();
  }
  const root = cronStorageDir(dataDir, projectId, triggerId);
  const walk = listArtifactsInDir(root);
  const files = walk.artifacts.filter(
    (artifact) => artifact.id !== CRON_STORAGE_NOTE && !NOTE_TEMP_RE.test(artifact.id),
  );
  const noteFile = readArtifactInDir(root, CRON_STORAGE_NOTE);
  const note = noteFile ? readNote(noteFile.path) : null;
  const noteUpdatedAt = note === null ? null : (noteFile?.updatedAt ?? null);
  const stamps = [
    ...files.map((file) => file.updatedAt),
    ...(noteUpdatedAt ? [noteUpdatedAt] : []),
  ];
  return {
    note: note ?? "",
    noteUpdatedAt,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    updatedAt: stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null,
    truncated: walk.truncated,
  };
}

/** One file under the storage dir, realpath-contained; null when absent or unsafe. */
export function readCronStorageFile(
  dataDir: string,
  projectId: string,
  triggerId: string,
  artifactId: string,
): SessionArtifactFile | null {
  if (!assertCronStorageRoot(dataDir, projectId, triggerId)) {
    return null;
  }
  return readArtifactInDir(cronStorageDir(dataDir, projectId, triggerId), artifactId);
}

/** Replaces note.md atomically via a fresh temp file; never writes through an existing path. */
export function writeCronStorageNote(
  dataDir: string,
  projectId: string,
  triggerId: string,
  note: string,
): CronStorageView {
  const root = ensureCronStorageDir(dataDir, projectId, triggerId);
  const tempPath = join(root, `.note-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, note, { encoding: "utf-8", flag: "wx" });
    renameSync(tempPath, join(root, CRON_STORAGE_NOTE));
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return readCronStorage(dataDir, projectId, triggerId);
}

/** Removes the storage dir. A symlinked dir is unlinked, its target left untouched. */
export function clearCronStorage(
  dataDir: string,
  projectId: string,
  triggerId: string,
): CronStorageView {
  const [top, project, root] = storageLevels(dataDir, projectId, triggerId);
  if (lstatLevel(top) === null || lstatLevel(project) === null) {
    return emptyView();
  }
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyView();
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(root);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
  return emptyView();
}

/** Launch prompt block for a cron-spawned session; `writable` false drops the update line. */
export function cronStorageInstructions(writable: boolean): string {
  const lines = [
    "Cron storage:",
    "- `$SPUR_CRON_STORAGE_DIR` persists across every run of this cron job.",
    "- Read `note.md` and the other files there first; they are context from earlier runs.",
  ];
  if (writable) {
    lines.push(
      "- Before you finish, update `note.md` and the files so the next run starts from them.",
    );
  }
  return lines.join("\n");
}
