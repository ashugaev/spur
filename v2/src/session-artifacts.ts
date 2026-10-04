import {
  type Dir,
  type Dirent,
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
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

// Every entry pulled from a below-root directory costs one tick, and opening that
// directory costs one tick too, whether the directory turns out empty, its entries become
// files, skipped symlinks, or enqueued directories. Charging the open itself is what bounds
// syscalls on a tree of many (possibly empty) directories, not only on a tree with many
// entries — the nested listing is pulled incrementally (opendirSync + readSync), so one
// oversized directory cannot exceed this budget either. The root level is never capped: see
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
 * Deletes exactly one artifact by id and drops its `.spur-artifacts.json` entry. The
 * explicit counterpart to `deleteSessionArtifactsExcept`: it can only ever remove the id it
 * was handed, so a short or lossy listing upstream can never widen it into deleting a file
 * nobody selected. Returns false when the id is unsafe, resolves outside the artifacts root,
 * or is not a regular file. Removes no directory: only the named file.
 */
export function deleteSessionArtifactById(
  dataDir: string,
  sessionId: string,
  artifactId: string,
): boolean {
  const normalizedId = parseArtifactRelativePath(artifactId);
  if (normalizedId === null) {
    return false;
  }
  const dir = sessionArtifactsDir(dataDir, sessionId);
  const path = join(dir, normalizedId);
  let resolvedRoot: string;
  let resolvedPath: string;
  try {
    resolvedRoot = realpathSync(dir);
    // realpath, not lstat: an id whose own last segment is a symlink pointing outside the
    // root must never be followed into a delete. Containment is checked on the resolution.
    resolvedPath = realpathSync(path);
  } catch {
    return false;
  }
  if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return false;
  }
  try {
    if (!statSync(resolvedPath).isFile()) {
      return false;
    }
    rmSync(resolvedPath, { force: true });
  } catch {
    return false;
  }
  const metadata = readArtifactMetadata(dir);
  if (metadata[normalizedId]) {
    writeArtifactMetadata(
      dir,
      Object.fromEntries(
        Object.entries(metadata).filter(([artifactId]) => artifactId !== normalizedId),
      ),
    );
  }
  return true;
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

// A parent-pointer chain of resolved directory paths from a queued directory back up to
// the artifacts root. Used only to detect a symlink re-entering a directory already on its
// own path from the root — see the D4 discussion on listSessionArtifacts.
interface DirChain {
  readonly dir: string;
  readonly parent: DirChain | null;
}

function chainContains(chain: DirChain, resolvedPath: string): boolean {
  let node: DirChain | null = chain;
  while (node) {
    if (node.dir === resolvedPath) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/**
 * D1 amendment, deviation from spec.md's original D1 (see spec.md Amendments): some
 * filesystems (XFS without ftype, some FUSE/NFS mounts) report DT_UNKNOWN for a dirent, for
 * which Node's `isFile()`/`isDirectory()`/`isSymbolicLink()` all return false. The original
 * D1 branch skipped such an entry, which silently drops every artifact on such a filesystem.
 * Called ONLY when all three predicates are false, so it costs nothing on a filesystem that
 * reports dirent types correctly — every case the benchmarks measured.
 */
function statUnknownDirent(entryPath: string): Stats | null {
  try {
    return lstatSync(entryPath);
  } catch {
    return null;
  }
}

/**
 * Shared by the root and nested walk loops: resolves a DT_UNKNOWN dirent's real type via
 * lstatSync and classifies it. The two loops still emit/enqueue the result themselves — the
 * root loop never row-caps, the nested loop does (and breaks the labeled walk on truncation)
 * — so only the classification (the three-way isFile/isDirectory/isSymbolicLink dispatch) is
 * shared; folding the differing emission logic in too would need a callback per loop, which
 * is more indirection than the ~10 duplicated lines it would save.
 */
function classifyUnknownDirent(
  entryPath: string,
): { stat: Stats; kind: "file" | "directory" | "symlink" } | null {
  const stat = statUnknownDirent(entryPath);
  if (stat === null) {
    return null;
  }
  if (stat.isFile()) {
    return { stat, kind: "file" };
  }
  if (stat.isDirectory()) {
    return { stat, kind: "directory" };
  }
  if (stat.isSymbolicLink()) {
    return { stat, kind: "symlink" };
  }
  return null;
}

/**
 * Lists every artifact under the session's artifacts directory, breadth-first by depth.
 * The root level (depth 1) is never capped — every root file is always enumerated and
 * emitted, at zero syscall cost for a plain (non-symlink) directory. Below the root, the
 * walk is bounded by two budgets: MAX_NESTED_ARTIFACT_WALK_ENTRIES charges one tick per
 * directory opened AND one tick per entry pulled from it (a directory is pulled
 * incrementally via opendirSync/readSync, so one oversized directory cannot exceed the
 * budget by itself), and MAX_NESTED_ARTIFACT_ROWS caps emitted nested rows. Hitting either
 * stops the walk and sets `truncated`. A plain (non-symlink) dirent is never realpath'd or
 * stat'd — its path is provably inside the root and provably longer than any ancestor, so
 * it can never form a cycle. Only a symlink resolving to a directory is checked against the
 * ancestor chain of resolved paths from the root down to its parent; a match means the link
 * re-enters a directory already on its own path and is skipped (not an error — an alias of
 * an ancestor, not lost work). Two distinct paths reaching the same physical directory
 * (neither on the other's chain) are both listed.
 */
export function listSessionArtifacts(dataDir: string, sessionId: string): ArtifactWalkResult {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  if (!existsSync(dir)) {
    return { artifacts: [], truncated: false };
  }

  let resolvedRoot: string;
  let rootEntries: Dirent[];
  try {
    resolvedRoot = realpathSync(dir);
    rootEntries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { artifacts: [], truncated: false };
  }

  const metadata = readArtifactMetadata(dir);
  const files: SessionArtifactFile[] = [];
  const rootChain: DirChain = { dir: resolvedRoot, parent: null };

  const isInsideRoot = (resolvedPath: string): boolean =>
    resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);

  rootEntries.sort((left, right) => left.name.localeCompare(right.name));

  let nextLevel: { dir: string; relPath: string; chain: DirChain }[] = [];

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
    if (entry.isDirectory()) {
      // A non-symlink child of the (already-realpathed) root is itself a contained
      // realpath, strictly longer than resolvedRoot — it can never equal an ancestor, so
      // no chain check and no syscall.
      const entryPath = join(resolvedRoot, entry.name);
      nextLevel.push({
        dir: entryPath,
        relPath: entry.name,
        chain: { dir: entryPath, parent: rootChain },
      });
      continue;
    }
    if (!entry.isSymbolicLink()) {
      // D1 amendment (see spec.md Amendments): a DT_UNKNOWN dirent reports isFile(),
      // isDirectory(), and isSymbolicLink() all false. Resolve its real type with one
      // lstatSync fallback rather than silently dropping it.
      const classified = classifyUnknownDirent(join(dir, entry.name));
      if (classified === null) {
        continue;
      }
      if (classified.kind === "file") {
        try {
          files.push(
            artifactFromStat(join(dir, entry.name), entry.name, classified.stat, metadata),
          );
        } catch {
          // Stat failure on one entry skips that entry; it does not abort the listing.
        }
        continue;
      }
      if (classified.kind === "directory") {
        const entryPath = join(resolvedRoot, entry.name);
        nextLevel.push({
          dir: entryPath,
          relPath: entry.name,
          chain: { dir: entryPath, parent: rootChain },
        });
        continue;
      }
      // classified.kind === "symlink": falls through and takes
      // the same realpath + containment + stat path as an ordinary symlink dirent below.
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
      // G1: a symlink resolving to a directory must be checked against rootChain before
      // being enqueued — a `self -> <root>` link resolves to resolvedRoot itself, matches
      // rootChain's own head, and is skipped. Without this check it would be enqueued and
      // the nested loop would re-list every root file under `self/`.
      if (chainContains(rootChain, resolvedEntry)) {
        continue;
      }
      nextLevel.push({
        dir: resolvedEntry,
        relPath: entry.name,
        chain: { dir: resolvedEntry, parent: rootChain },
      });
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
      if (walkEntriesExamined >= MAX_NESTED_ARTIFACT_WALK_ENTRIES) {
        truncated = true;
        break walkLevels;
      }

      // opendirSync+readSync measures ~2.6x slower per directory than a batched
      // readdirSync at IDENTICAL syscall counts (JS-binding cost, not kernel work) — kept
      // anyway because it bounds allocation on one oversized directory (123k-file case);
      // do not "optimize" this back to readdirSync.
      let dirHandle: Dir;
      try {
        dirHandle = opendirSync(item.dir);
      } catch {
        continue;
      }
      // D2: charge one tick for opening the directory itself, so a tree of many (possibly
      // empty) directories trips the budget on expansion alone.
      walkEntriesExamined++;

      const entries: Dirent[] = [];
      try {
        // D3: exactly two stop conditions — the directory is exhausted (readSync
        // returns null) or the entry budget is spent. The row cap is not evaluable here:
        // rows are only emitted after this pulled slice is sorted below. A throw from
        // readSync (e.g. the directory vanished mid-read) skips this directory only, same
        // as an opendirSync failure above — it does not abort the listing.
        while (walkEntriesExamined < MAX_NESTED_ARTIFACT_WALK_ENTRIES) {
          const entry = dirHandle.readSync();
          if (entry === null) {
            break;
          }
          entries.push(entry);
          walkEntriesExamined++;
        }
      } catch {
        continue;
      } finally {
        try {
          dirHandle.closeSync();
        } catch {
          // closeSync on an already-broken handle does not abort the listing either.
        }
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relPath = `${item.relPath}/${entry.name}`;
        if (entry.isFile()) {
          const entryPath = join(item.dir, entry.name);
          if (nestedRowsEmitted >= MAX_NESTED_ARTIFACT_ROWS) {
            truncated = true;
            break walkLevels;
          }
          nestedRowsEmitted++;
          try {
            files.push(artifactFromFile(entryPath, relPath, metadata));
          } catch {
            // Skip this entry only.
          }
          continue;
        }
        if (entry.isDirectory()) {
          // Non-symlink child of a contained realpath: same D1 argument as the root loop.
          const entryPath = join(item.dir, entry.name);
          nextLevel.push({
            dir: entryPath,
            relPath,
            chain: { dir: entryPath, parent: item.chain },
          });
          continue;
        }
        if (!entry.isSymbolicLink()) {
          // D1 amendment (see spec.md Amendments): same DT_UNKNOWN fallback as the root
          // loop.
          const classified = classifyUnknownDirent(join(item.dir, entry.name));
          if (classified === null) {
            continue;
          }
          if (classified.kind === "file") {
            if (nestedRowsEmitted >= MAX_NESTED_ARTIFACT_ROWS) {
              truncated = true;
              break walkLevels;
            }
            nestedRowsEmitted++;
            try {
              files.push(
                artifactFromStat(join(item.dir, entry.name), relPath, classified.stat, metadata),
              );
            } catch {
              // Skip this entry only.
            }
            continue;
          }
          if (classified.kind === "directory") {
            const entryPath = join(item.dir, entry.name);
            nextLevel.push({
              dir: entryPath,
              relPath,
              chain: { dir: entryPath, parent: item.chain },
            });
            continue;
          }
          // classified.kind === "symlink": falls through, lstat says this DT_UNKNOWN entry
          // is actually a symlink.
        }
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
          if (chainContains(item.chain, resolvedEntry)) {
            continue;
          }
          nextLevel.push({
            dir: resolvedEntry,
            relPath,
            chain: { dir: resolvedEntry, parent: item.chain },
          });
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

      if (walkEntriesExamined >= MAX_NESTED_ARTIFACT_WALK_ENTRIES) {
        truncated = true;
        break walkLevels;
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
