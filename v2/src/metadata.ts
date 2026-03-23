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
import type { SessionRecord } from "./types.js";

function sessionFilePath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "sessions", projectId, `${sessionId}.json`);
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

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  return {
    id: session.id,
    project: session.project,
    agent: session.agent,
    agentSessionId: session.agentSessionId,
    prompt: session.prompt,
    branch: session.branch,
    worktreePath: session.worktreePath,
    tmuxSession: session.tmuxSession,
    launchCommand: session.launchCommand,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.error ? { error: session.error } : {}),
  };
}

export function writeSession(dataDir: string, session: SessionRecord): void {
  writeJsonFile(
    sessionFilePath(dataDir, session.project, session.id),
    normalizeSessionRecord(session),
  );
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

export function deleteSession(dataDir: string, sessionId: string): void {
  const path = findSessionFilePath(dataDir, sessionId);
  if (!path) return;
  rmSync(path, { force: true });
}
