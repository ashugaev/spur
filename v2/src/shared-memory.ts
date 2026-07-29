import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_KEY_PATTERN, SESSION_ID_PATTERN } from "./session-memory.js";
import type { SharedMemoryEntry, SharedMemoryScope } from "./types.js";

// Three shared markdown-memory scopes, one .md file per key:
//   <dataDir>/memory/task/<deskId ?? sessionId>/<key>.md    — desk-group siblings
//   <dataDir>/memory/project/<projectId>/<key>.md           — all sessions of a project
//   <dataDir>/memory/global/<key>.md                        — whole Spur instance
// Concurrency contract: last-writer-wins per key. No locking by design.
const SHARED_MEMORY_MARKER = "spur memory set|get|list|rm";

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
    .filter((name) => name.endsWith(".md") && !name.includes(".tmp."))
    .map((name) => name.slice(0, -3))
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
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, body, "utf-8");
  renameSync(tmpPath, path);
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
  if (prompt.includes(SHARED_MEMORY_MARKER)) {
    return prompt;
  }
  return `${prompt}

Shared memory:
- \`spur memory set|get|list|rm [key] [body] --scope task|project|global\`. One markdown cell per key. \`set\` overwrites. Multiline body via \`--file <path>\`. Every agent in the scope sees the same cells.
- On start: \`spur memory list --scope task\` and \`spur memory list --scope project\`. Read the cells relevant to your work before acting.
- Write when you learn something durable. High-value only, no noise:
  - task: business requirements, decisions, and constraints of THIS task — what a sibling desk agent must know.
  - project: critical project knowledge that cost you time until you understood it — gotchas, invariants, non-obvious behavior.
  - global: user preferences and rules that hold across every project.
- Cell style: caveman. Terse, exact, no filler. State the fact and why it matters. Overwrite stale cells, \`rm\` dead ones.
- Do not store: session-local scratch, anything derivable from the repo, restated docs, logs.`;
}
