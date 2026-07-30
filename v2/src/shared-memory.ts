import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_KEY_PATTERN, SESSION_ID_PATTERN, writeFileAtomic } from "./session-memory.js";
import type { SharedMemoryEntry, SharedMemoryScope } from "./types.js";

// Three shared markdown-memory scopes, one .md file per key:
//   <dataDir>/memory/task/<deskId ?? sessionId>/<key>.md    — desk-group siblings
//   <dataDir>/memory/project/<projectId>/<key>.md           — all sessions of a project
//   <dataDir>/memory/global/<key>.md                        — whole Spur instance
// Concurrency contract: last-writer-wins per key. No locking by design.
//
// This is the block's own section heading, not the CLI usage string — a task prompt
// that happens to quote `spur memory set|get|list|rm` must not be mistaken for a
// prompt that already carries the block. handoff-prompt.ts strips the same block by
// this exact marker, so the two must never drift; it imports this constant rather
// than redefining the string.
export const SHARED_MEMORY_SECTION_MARKER = "\n\nShared memory:";

export function assertValidSharedMemoryScope(scope: string): asserts scope is SharedMemoryScope {
  if (scope !== "task" && scope !== "project" && scope !== "global") {
    throw new Error("shared memory scope must be task, project, or global");
  }
}

export function validateSharedMemoryStoreId(storeId: string): void {
  if (!SESSION_ID_PATTERN.test(storeId)) {
    throw new Error("shared memory store id must match ^[A-Za-z0-9_-]+$");
  }
}

export function validateSharedMemoryKey(key: string): void {
  if (!MEMORY_KEY_PATTERN.test(key)) {
    throw new Error("shared memory key must match ^[a-z0-9][a-z0-9._-]{0,63}$");
  }
}

function sharedMemoryDir(dataDir: string, scope: SharedMemoryScope, storeId: string): string {
  if (scope === "global") {
    return join(dataDir, "memory", "global");
  }
  return join(dataDir, "memory", scope, storeId);
}

function sharedMemoryFilePath(
  dataDir: string,
  scope: SharedMemoryScope,
  storeId: string,
  key: string,
): string {
  return join(sharedMemoryDir(dataDir, scope, storeId), `${key}.md`);
}

export function listSharedMemoryKeys(dataDir: string, scope: string, storeId: string): string[] {
  assertValidSharedMemoryScope(scope);
  validateSharedMemoryStoreId(storeId);
  const dir = sharedMemoryDir(dataDir, scope, storeId);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .filter((name) => MEMORY_KEY_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right));
}

export function getSharedMemory(
  dataDir: string,
  scope: string,
  storeId: string,
  key: string,
): SharedMemoryEntry | null {
  assertValidSharedMemoryScope(scope);
  validateSharedMemoryStoreId(storeId);
  validateSharedMemoryKey(key);
  const path = sharedMemoryFilePath(dataDir, scope, storeId, key);
  if (!existsSync(path)) {
    return null;
  }
  return { key, body: readFileSync(path, "utf-8") };
}

export function setSharedMemory(
  dataDir: string,
  scope: string,
  storeId: string,
  key: string,
  body: string,
): SharedMemoryEntry {
  assertValidSharedMemoryScope(scope);
  validateSharedMemoryStoreId(storeId);
  validateSharedMemoryKey(key);
  const path = sharedMemoryFilePath(dataDir, scope, storeId, key);
  writeFileAtomic(path, body);
  return { key, body };
}

export function removeSharedMemory(
  dataDir: string,
  scope: string,
  storeId: string,
  key: string,
): boolean {
  assertValidSharedMemoryScope(scope);
  validateSharedMemoryStoreId(storeId);
  validateSharedMemoryKey(key);
  const path = sharedMemoryFilePath(dataDir, scope, storeId, key);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}

export function withSharedMemoryInstructions(prompt: string): string {
  if (prompt.includes(SHARED_MEMORY_SECTION_MARKER)) {
    return prompt;
  }
  return `${prompt}${SHARED_MEMORY_SECTION_MARKER}
- \`spur memory set|get|list|rm [key] [body] --scope task|project|global\`. One cell per key; \`set\` overwrites; \`--file <path>\` for multiline.
- On start: \`spur memory list --scope task\` and \`--scope project\`. Read what applies before acting.
- Write durable facts only: task = this task's requirements/decisions for sibling desk agents; project = hard-won gotchas/invariants; global = user prefs across projects.
- Cell body: caveman, terse, exact. No scratch, derivable info, or logs.`;
}
