import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type { SessionArtifact, SessionArtifactKind, SessionArtifactOrigin } from "./types.js";

const ARTIFACTS_DIR = "session-artifacts";
const ARTIFACT_METADATA_FILE = ".spur-artifacts.json";

const MIME_BY_EXT: Record<string, string> = {
  ".gif": "image/gif",
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

function artifactFromFile(
  path: string,
  name: string,
  metadata: ArtifactMetadataMap,
): SessionArtifactFile {
  const stat = statSync(path);
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

function validateArtifactId(artifactId: string): string {
  const trimmed = artifactId.trim();
  if (!trimmed || trimmed !== basename(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid artifact id: ${artifactId}`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid artifact id: ${artifactId}`);
  }
  return trimmed;
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

export function deleteSessionArtifactsExcept(
  dataDir: string,
  sessionId: string,
  keepArtifactIds: string[],
): void {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  if (!existsSync(dir)) {
    return;
  }
  const keep = new Set(keepArtifactIds.map((artifactId) => validateArtifactId(artifactId)));
  const metadata = readArtifactMetadata(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === ARTIFACT_METADATA_FILE || keep.has(entry.name)) {
      continue;
    }
    rmSync(join(dir, entry.name), { force: true });
  }
  writeArtifactMetadata(
    dir,
    Object.fromEntries(Object.entries(metadata).filter(([artifactId]) => keep.has(artifactId))),
  );
}

export function listSessionArtifacts(dataDir: string, sessionId: string): SessionArtifact[] {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  if (!existsSync(dir)) {
    return [];
  }

  try {
    const metadata = readArtifactMetadata(dir);
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== ARTIFACT_METADATA_FILE)
      .map((entry) => artifactFromFile(join(dir, entry.name), entry.name, metadata))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ path: _path, ...artifact }) => artifact);
  } catch {
    return [];
  }
}

export function readSessionArtifact(
  dataDir: string,
  sessionId: string,
  artifactId: string,
): SessionArtifactFile | null {
  const normalizedId = validateArtifactId(artifactId);
  if (normalizedId === ARTIFACT_METADATA_FILE) {
    return null;
  }
  const path = join(sessionArtifactsDir(dataDir, sessionId), normalizedId);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  return artifactFromFile(
    path,
    normalizedId,
    readArtifactMetadata(sessionArtifactsDir(dataDir, sessionId)),
  );
}

export function setSessionArtifactOrigin(
  dataDir: string,
  sessionId: string,
  artifactId: string,
  origin: SessionArtifactOrigin,
): void {
  const normalizedId = validateArtifactId(artifactId);
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
  const normalizedId = validateArtifactId(artifactId);
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
- Prefer direct child files with stable names and overwrite them when updating an artifact.`;
}
