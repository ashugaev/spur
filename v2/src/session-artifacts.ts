import {
  type Dirent,
  type Stats,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, sep } from "node:path";
import type { SessionArtifact, SessionArtifactKind, SessionArtifactOrigin } from "./types.js";

const ARTIFACTS_DIR = "session-artifacts";
const ARTIFACT_METADATA_FILE = ".spur-artifacts.json";

// Every readdir entry examined below the root (depth >= 2) costs one tick, whether it
// becomes a file, a skipped symlink, or an enqueued directory. Directories count too, so
// this bounds syscalls below the root, not only rows. The root level is never capped: see
// listSessionArtifacts.
export const MAX_NESTED_ARTIFACT_WALK_ENTRIES = 2000;
// Emitted SessionArtifact objects at depth >= 2. Depth-1 rows never consume this.
export const MAX_NESTED_ARTIFACT_ROWS = 200;

const MIME_BY_EXT: Record<string, string> = {
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".imd": "text/plain; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export interface SessionArtifactFile extends SessionArtifact {
  path: string;
}

interface ArtifactMetadataRecord {
  origin?: SessionArtifactOrigin;
  addedByUser?: boolean;
}

type ArtifactMetadataMap = Record<string, ArtifactMetadataRecord>;

function isArtifactMetadataRecord(value: unknown): value is ArtifactMetadataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { origin?: unknown; addedByUser?: unknown };
  return (
    (candidate.origin === undefined ||
      candidate.origin === "intentional" ||
      candidate.origin === "automatic") &&
    (candidate.addedByUser === undefined || typeof candidate.addedByUser === "boolean")
  );
}

function artifactKindForMimeType(mimeType: string): SessionArtifactKind {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return "download";
}

function artifactMimeType(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function isImageArtifactPath(path: string): boolean {
  return artifactKindForMimeType(artifactMimeType(basename(path))) === "image";
}

function readArtifactMetadata(dir: string): ArtifactMetadataMap {
  const metadataPath = join(dir, ARTIFACT_METADATA_FILE);
  if (!existsSync(metadataPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([artifactId, metadata]) =>
          typeof artifactId === "string" && isArtifactMetadataRecord(metadata),
      ),
    );
  } catch {
    return {};
  }
}

function writeArtifactMetadata(dir: string, metadata: ArtifactMetadataMap): void {
  const metadataPath = join(dir, ARTIFACT_METADATA_FILE);
  if (Object.keys(metadata).length === 0) {
    rmSync(metadataPath, { force: true });
    return;
  }
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
}

function artifactOrigin(metadata: ArtifactMetadataMap, name: string): SessionArtifactOrigin {
  return metadata[name]?.origin ?? "intentional";
}

function artifactAddedByUser(metadata: ArtifactMetadataMap, name: string): boolean {
  return metadata[name]?.addedByUser === true;
}

function artifactFromStat(
  path: string,
  name: string,
  stat: Stats,
  metadata: ArtifactMetadataMap,
): SessionArtifactFile {
  const mimeType = artifactMimeType(name);
  return {
    id: name,
    name,
    size: stat.size,
    mimeType,
    kind: artifactKindForMimeType(mimeType),
    origin: artifactOrigin(metadata, name),
    addedByUser: artifactAddedByUser(metadata, name),
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    path,
  };
}

function artifactFromFile(
  path: string,
  name: string,
  metadata: ArtifactMetadataMap,
): SessionArtifactFile {
  return artifactFromStat(path, name, statSync(path), metadata);
}

/**
 * Parses a raw artifact id into the POSIX path relative to the artifacts root, or returns
 * null when the id is unsafe. Pure: does not touch the filesystem. Rejects an empty id, a
 * NUL byte, a backslash, a "." or ".." segment, an empty segment (a leading/trailing/double
 * "/"), and the reserved metadata filename. Every accepted id resolves lexically inside the
 * artifacts root; readSessionArtifact additionally enforces realpath containment before it
 * reads (a lexically clean id can still be a symlink pointing outside the root).
 */
export function parseArtifactRelativePath(artifactId: string): string | null {
  const trimmed = artifactId.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("\u0000") || trimmed.includes("\\")) {
    return null;
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  const relativePath = segments.join("/");
  if (relativePath === ARTIFACT_METADATA_FILE) {
    return null;
  }
  return relativePath;
}

export function validateArtifactRelativePath(artifactId: string): string {
  const parsed = parseArtifactRelativePath(artifactId);
  if (parsed === null) {
    throw new Error(`Invalid artifact id: ${artifactId}`);
  }
  return parsed;
}

export function sessionArtifactsDir(dataDir: string, sessionId: string): string {
  return join(dataDir, ARTIFACTS_DIR, sessionId);
}

export function ensureSessionArtifactsDir(dataDir: string, sessionId: string): string {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function deleteSessionArtifactsDir(dataDir: string, sessionId: string): void {
  rmSync(sessionArtifactsDir(dataDir, sessionId), {
    force: true,
    recursive: true,
  });
}

/**
 * Deletes every artifact not in `keepArtifactIds`, then prunes emptied directories.
 * Walks with `withFileTypes` (lstat semantics): it never descends into a symlinked
 * directory (a followed link would `rmSync` outside the artifacts root); a symlink entry
 * is unlinked as itself. Directories are removed bottom-up with non-recursive `rmdirSync`,
 * which is atomic with respect to a concurrent write — ENOTEMPTY (a file landed there after
 * the file pass, or it still holds a kept file) and ENOENT are both swallowed.
 */
export function deleteSessionArtifactsExcept(
  dataDir: string,
  sessionId: string,
  keepArtifactIds: string[],
): void {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  if (!existsSync(dir)) {
    return;
  }
  const keep = new Set(
    keepArtifactIds.map((artifactId) => validateArtifactRelativePath(artifactId)),
  );
  const metadata = readArtifactMetadata(dir);

  // Post-order: a directory is pushed only after every entry inside it (including nested
  // subdirectories) has been visited, so the removal pass below is naturally bottom-up.
  const directories: string[] = [];

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, relPath);
        directories.push(relPath);
        continue;
      }
      if (relPath === ARTIFACT_METADATA_FILE || keep.has(relPath)) {
        continue;
      }
      rmSync(entryPath, { force: true });
    }
  };
  walk(dir, "");

  for (const relPath of directories) {
    try {
      rmdirSync(join(dir, relPath));
    } catch {
      // ENOTEMPTY (a kept file, or one written concurrently, still lives here) or ENOENT
      // (already removed via an ancestor) — both are fine, the directory stays or is gone.
    }
  }

  writeArtifactMetadata(
    dir,
    Object.fromEntries(Object.entries(metadata).filter(([artifactId]) => keep.has(artifactId))),
  );
}

interface ArtifactWalkResult {
  artifacts: SessionArtifact[];
  truncated: boolean;
}

/**
 * Lists every artifact under the session's artifacts directory, breadth-first by depth.
 * The root level (depth 1) is never capped — every root file is always enumerated and
 * emitted. Below the root, the walk is bounded by two budgets (MAX_NESTED_ARTIFACT_WALK_
 * ENTRIES, MAX_NESTED_ARTIFACT_ROWS); hitting either stops the walk and sets `truncated`.
 * Symlinks are followed, behind a realpath containment check against the artifacts root; a
 * directory-graph cycle is caught by a `dev:ino` visited set spanning the whole walk, seeded
 * with the root's own `dev:ino` so a symlink pointing back at the root cannot re-list it.
 */
export function listSessionArtifacts(dataDir: string, sessionId: string): ArtifactWalkResult {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  if (!existsSync(dir)) {
    return { artifacts: [], truncated: false };
  }

  let resolvedRoot: string;
  let rootStat: Stats;
  let rootEntries: Dirent[];
  try {
    resolvedRoot = realpathSync(dir);
    rootStat = statSync(resolvedRoot);
    rootEntries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { artifacts: [], truncated: false };
  }

  const metadata = readArtifactMetadata(dir);
  const files: SessionArtifactFile[] = [];
  const visited = new Set<string>([`${rootStat.dev}:${rootStat.ino}`]);

  const isInsideRoot = (resolvedPath: string): boolean =>
    resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);

  rootEntries.sort((left, right) => left.name.localeCompare(right.name));

  let nextLevel: { dir: string; relPath: string }[] = [];

  for (const entry of rootEntries) {
    if (entry.name === ARTIFACT_METADATA_FILE) {
      continue;
    }
    if (entry.isFile()) {
      // A depth-1 entry readdir reports as a plain file (not a symlink) is already
      // inside the already-realpathed root; no realpathSync needed to contain it.
      try {
        files.push(artifactFromFile(join(dir, entry.name), entry.name, metadata));
      } catch {
        // Stat failure on one entry skips that entry; it does not abort the listing.
      }
      continue;
    }
    const entryPath = join(dir, entry.name);
    let resolvedEntry: string;
    let entryStat: Stats;
    try {
      resolvedEntry = realpathSync(entryPath);
      if (!isInsideRoot(resolvedEntry)) {
        continue;
      }
      entryStat = statSync(resolvedEntry);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      const key = `${entryStat.dev}:${entryStat.ino}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      nextLevel.push({ dir: resolvedEntry, relPath: entry.name });
    } else if (entryStat.isFile()) {
      try {
        files.push(artifactFromStat(resolvedEntry, entry.name, entryStat, metadata));
      } catch {
        // Skip this entry only.
      }
    }
  }

  let walkEntriesExamined = 0;
  let nestedRowsEmitted = 0;
  let truncated = false;

  walkLevels: while (nextLevel.length > 0) {
    const level = nextLevel;
    nextLevel = [];
    for (const item of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (walkEntriesExamined >= MAX_NESTED_ARTIFACT_WALK_ENTRIES) {
          truncated = true;
          break walkLevels;
        }
        walkEntriesExamined++;

        const relPath = `${item.relPath}/${entry.name}`;
        const entryPath = join(item.dir, entry.name);
        let resolvedEntry: string;
        let entryStat: Stats;
        try {
          resolvedEntry = realpathSync(entryPath);
          if (!isInsideRoot(resolvedEntry)) {
            continue;
          }
          entryStat = statSync(resolvedEntry);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = `${entryStat.dev}:${entryStat.ino}`;
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);
          nextLevel.push({ dir: resolvedEntry, relPath });
        } else if (entryStat.isFile()) {
          if (nestedRowsEmitted >= MAX_NESTED_ARTIFACT_ROWS) {
            truncated = true;
            break walkLevels;
          }
          nestedRowsEmitted++;
          try {
            files.push(artifactFromStat(resolvedEntry, relPath, entryStat, metadata));
          } catch {
            // Skip this entry only.
          }
        }
      }
    }
  }

  return {
    artifacts: files
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ path: _path, ...artifact }) => artifact),
    truncated,
  };
}

export function readSessionArtifact(
  dataDir: string,
  sessionId: string,
  artifactId: string,
): SessionArtifactFile | null {
  const normalizedId = parseArtifactRelativePath(artifactId);
  if (normalizedId === null) {
    return null;
  }
  const dir = sessionArtifactsDir(dataDir, sessionId);
  const path = join(dir, normalizedId);
  let resolvedRoot: string;
  let resolvedPath: string;
  try {
    resolvedRoot = realpathSync(dir);
    resolvedPath = realpathSync(path);
  } catch {
    return null;
  }
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }
  let stat: Stats;
  try {
    stat = statSync(resolvedPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  return artifactFromStat(resolvedPath, normalizedId, stat, readArtifactMetadata(dir));
}

export function setSessionArtifactOrigin(
  dataDir: string,
  sessionId: string,
  artifactId: string,
  origin: SessionArtifactOrigin,
): void {
  const normalizedId = validateArtifactRelativePath(artifactId);
  const dir = ensureSessionArtifactsDir(dataDir, sessionId);
  const metadata = readArtifactMetadata(dir);
  metadata[normalizedId] = { ...metadata[normalizedId], origin };
  writeArtifactMetadata(dir, metadata);
}

export function setSessionArtifactUserAdded(
  dataDir: string,
  sessionId: string,
  artifactId: string,
  addedByUser: boolean,
): void {
  const normalizedId = validateArtifactRelativePath(artifactId);
  const dir = ensureSessionArtifactsDir(dataDir, sessionId);
  const metadata = readArtifactMetadata(dir);
  metadata[normalizedId] = { ...metadata[normalizedId], addedByUser };
  writeArtifactMetadata(dir, metadata);
}

export function withSessionArtifactInstructions(prompt: string): string {
  if (prompt.includes("SPUR_SESSION_ARTIFACTS_DIR")) {
    return prompt;
  }
  return `${prompt}

Session artifacts:
- Use \`$SPUR_SESSION_ARTIFACTS_DIR\` for temporary session-owned files you want Spur to track.
- For screenshots, videos, traces, logs, and other test outputs, write the file to \`$SPUR_SESSION_ARTIFACTS_DIR\` instead of leaving it in the repo worktree.
- If you generate an artifact you want the user to inspect in Spur UI, always put it in \`$SPUR_SESSION_ARTIFACTS_DIR\`.
- Files written there are not committed from the repo workspace and are tied to this Spur session.
- Images, videos, and text files (including .txt, .md, .json) written there appear inline in Spur UI. Other files appear as download links.
- HTML files render as a live preview in Spur UI, with a button that opens the page standalone at its artifact URL.
- A file written in a subfolder of \`$SPUR_SESSION_ARTIFACTS_DIR\` is listed under its path relative to that directory (for example \`design/design-spec.md\`).`;
}
