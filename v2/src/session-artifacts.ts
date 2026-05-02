import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { SessionArtifact, SessionArtifactKind } from "./types.js";

const ARTIFACTS_DIR = "session-artifacts";

const MIME_BY_EXT: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain; charset=utf-8",
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

function artifactKindForMimeType(mimeType: string): SessionArtifactKind {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "download";
}

function artifactMimeType(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function artifactFromFile(path: string, name: string): SessionArtifactFile {
  const stat = statSync(path);
  const mimeType = artifactMimeType(name);
  return {
    id: name,
    name,
    size: stat.size,
    mimeType,
    kind: artifactKindForMimeType(mimeType),
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
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || keep.has(entry.name)) {
      continue;
    }
    rmSync(join(dir, entry.name), { force: true });
  }
}

export function listSessionArtifacts(dataDir: string, sessionId: string): SessionArtifact[] {
  const dir = sessionArtifactsDir(dataDir, sessionId);
  if (!existsSync(dir)) {
    return [];
  }

  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => artifactFromFile(join(dir, entry.name), entry.name))
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
  const path = join(sessionArtifactsDir(dataDir, sessionId), normalizedId);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  return artifactFromFile(path, normalizedId);
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
- Images and videos written there appear inline in Spur UI. Other files appear as download links.
- Prefer direct child files with stable names and overwrite them when updating an artifact.`;
}
