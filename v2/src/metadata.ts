import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { GitHubSignal, SessionRecord } from "./types.js";

function sessionFilePath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "sessions", projectId, `${sessionId}.json`);
}

function githubSnapshotDir(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "github", projectId, sourceId);
}

function githubSnapshotFilePath(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): string {
  return join(githubSnapshotDir(dataDir, projectId, sourceId), `${sessionId}.json`);
}

function readSessionFile(path: string): SessionRecord {
  return JSON.parse(readFileSync(path, "utf-8")) as SessionRecord;
}

function findSessionFilePath(dataDir: string, sessionId: string): string | null {
  const rootDir = join(dataDir, "sessions");
  if (!existsSync(rootDir)) return null;

  const fileName = `${sessionId}.json`;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(rootDir, entry.name, fileName);
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function parseGitHubSignals(path: string): Map<string, GitHubSignal> {
  const signals = JSON.parse(readFileSync(path, "utf-8")) as GitHubSignal[];
  return new Map(signals.map((signal) => [signal.key, signal] satisfies [string, GitHubSignal]));
}

export function writeSession(dataDir: string, session: SessionRecord): void {
  writeJsonFile(sessionFilePath(dataDir, session.project, session.id), session);
}

export function listSessions(dataDir: string): SessionRecord[] {
  const rootDir = join(dataDir, "sessions");
  if (!existsSync(rootDir)) return [];

  const sessions: SessionRecord[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(rootDir, entry.name);
    for (const fileName of readdirSync(projectDir)) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = join(projectDir, fileName);
      sessions.push(readSessionFile(filePath));
    }
  }

  sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sessions;
}

export function readSession(dataDir: string, sessionId: string): SessionRecord | null {
  const path = findSessionFilePath(dataDir, sessionId);
  return path ? readSessionFile(path) : null;
}

export function readGitHubSourceSnapshots(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Map<string, Map<string, GitHubSignal>> {
  const dir = githubSnapshotDir(dataDir, projectId, sourceId);
  if (!existsSync(dir)) return new Map();

  const snapshots = new Map<string, Map<string, GitHubSignal>>();
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const sessionId = fileName.slice(0, -".json".length);
    snapshots.set(sessionId, parseGitHubSignals(join(dir, fileName)));
  }
  return snapshots;
}

export function readGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): Map<string, GitHubSignal> | null {
  const path = githubSnapshotFilePath(dataDir, projectId, sourceId, sessionId);
  return existsSync(path) ? parseGitHubSignals(path) : null;
}

export function writeGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
  snapshot: Map<string, GitHubSignal>,
): void {
  writeJsonFile(githubSnapshotFilePath(dataDir, projectId, sourceId, sessionId), [
    ...snapshot.values(),
  ]);
}

export function deleteGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  rmSync(githubSnapshotFilePath(dataDir, projectId, sourceId, sessionId), {
    force: true,
  });
}
