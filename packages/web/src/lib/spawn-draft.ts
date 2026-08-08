import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import type { WorkspaceMode } from "@/lib/types";

const SPAWN_DRAFT_VERSION = 1;
const SPAWN_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SPAWN_DRAFT_STORAGE_PREFIX = "spur:spawn-draft";

export interface SpawnDraft {
  projectId: string;
  prompt: string;
  agent: AgentName;
  model: string | null;
  modelIsExplicit: boolean;
  branch: string;
  branchIsExplicit: boolean;
  workspaceMode: WorkspaceMode;
  defaultBranch: string;
  planMode: boolean;
  selfDestruct: boolean;
  selfDestructConditions: string;
  steps: string[];
  trackerUrl: string | null;
}

interface StoredSpawnDraft extends Omit<SpawnDraft, "modelIsExplicit"> {
  version: typeof SPAWN_DRAFT_VERSION;
  savedAt: number;
  // Optional: drafts written before modelIsExplicit existed (v1, pre-#535)
  // omit this field entirely. Treated as "not explicit" on read, see
  // readSpawnDraft, rather than discarding the whole draft.
  modelIsExplicit?: boolean;
}

function storageKey(projectId: string): string {
  return `${SPAWN_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(projectId)}`;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && AGENT_OPTIONS.some((agent) => agent === value);
}

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === "default" || value === "worktree" || value === "shared";
}

function isStoredSpawnDraft(
  value: unknown,
  projectId: string,
  now: number,
): value is StoredSpawnDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    draft.version === SPAWN_DRAFT_VERSION &&
    typeof draft.savedAt === "number" &&
    Number.isFinite(draft.savedAt) &&
    draft.savedAt <= now &&
    now - draft.savedAt <= SPAWN_DRAFT_MAX_AGE_MS &&
    draft.projectId === projectId &&
    typeof draft.prompt === "string" &&
    isAgentName(draft.agent) &&
    (draft.model === null || typeof draft.model === "string") &&
    (draft.modelIsExplicit === undefined || typeof draft.modelIsExplicit === "boolean") &&
    typeof draft.branch === "string" &&
    typeof draft.branchIsExplicit === "boolean" &&
    isWorkspaceMode(draft.workspaceMode) &&
    typeof draft.defaultBranch === "string" &&
    typeof draft.planMode === "boolean" &&
    typeof draft.selfDestruct === "boolean" &&
    typeof draft.selfDestructConditions === "string" &&
    Array.isArray(draft.steps) &&
    draft.steps.every((step) => typeof step === "string") &&
    (draft.trackerUrl === null || typeof draft.trackerUrl === "string")
  );
}

export function readSpawnDraft(
  projectId: string,
  storage: Storage | null = browserStorage(),
  now = Date.now(),
): SpawnDraft | null {
  if (!projectId || !storage) return null;
  const key = storageKey(projectId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSpawnDraft(parsed, projectId, now)) {
      storage.removeItem(key);
      return null;
    }
    const { version: _version, savedAt: _savedAt, ...draft } = parsed;
    // A draft written before modelIsExplicit existed (v1, pre-#535) never
    // recorded whether its model came from a user click or an auto-pick, so
    // it can't be trusted as explicit -- and the model value itself can't be
    // trusted either, since we don't know which case produced it. Restore
    // every other field, but null out the model instead of discarding the
    // whole draft. Also normalize the inverse invalid state (an explicit
    // model that is somehow null) the same way, since it can't be real.
    const modelIsExplicit = draft.modelIsExplicit === true && draft.model !== null;
    return {
      ...draft,
      model: draft.modelIsExplicit === undefined ? null : draft.model,
      modelIsExplicit,
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage can be unavailable even when window exists.
    }
    return null;
  }
}

export function writeSpawnDraft(
  draft: SpawnDraft,
  storage: Storage | null = browserStorage(),
  now = Date.now(),
): void {
  if (!draft.projectId || !storage) return;
  try {
    storage.setItem(
      storageKey(draft.projectId),
      JSON.stringify({ ...draft, version: SPAWN_DRAFT_VERSION, savedAt: now }),
    );
  } catch {
    // Draft persistence must not block spawning when storage is unavailable.
  }
}

export function clearSpawnDraft(
  projectId: string,
  storage: Storage | null = browserStorage(),
): void {
  if (!projectId || !storage) return;
  try {
    storage.removeItem(storageKey(projectId));
  } catch {
    // Draft cleanup must not block a confirmed spawn.
  }
}

export function spawnDraftStorageKey(projectId: string): string {
  return storageKey(projectId);
}
