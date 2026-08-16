import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import type { WorkspaceMode } from "@/lib/types";

const SPAWN_DRAFT_VERSION = 3;
const SPAWN_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SPAWN_DRAFT_STORAGE_KEY = "spur:spawn-draft";

export interface SpawnDraft {
  prompt: string;
  agent: AgentName;
  model: string | null;
  branch: string;
  branchIsExplicit: boolean;
  workspaceMode: WorkspaceMode;
  // The project id workspaceMode above was explicitly confirmed for (a
  // manual pick or an error-banner "Use worktree/shared" click), or null if
  // it has never been explicitly confirmed. A confirmation belongs to
  // exactly one project — the draft is a single global key shared across
  // every project, so a stored workspaceMode is usually just the
  // auto-derived default for whatever project it was last saved against.
  // Comparing this against the project the draft is restored onto (rather
  // than inferring "confirmed" from "a draft exists", or storing a bare
  // yes/no flag with no project attached) is what lets a restore correctly
  // tell the two cases apart.
  workspaceModeConfirmedFor: string | null;
  defaultBranch: string;
  planMode: boolean;
  selfDestruct: boolean;
  selfDestructConditions: string;
  steps: string[];
  trackerUrl: string | null;
  sessionMode: string | null;
}

interface StoredSpawnDraft extends SpawnDraft {
  version: typeof SPAWN_DRAFT_VERSION;
  savedAt: number;
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
  return value === "worktree" || value === "shared";
}

function isStoredSpawnDraft(value: unknown, now: number): value is StoredSpawnDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    draft.version === SPAWN_DRAFT_VERSION &&
    typeof draft.savedAt === "number" &&
    Number.isFinite(draft.savedAt) &&
    draft.savedAt <= now &&
    now - draft.savedAt <= SPAWN_DRAFT_MAX_AGE_MS &&
    typeof draft.prompt === "string" &&
    isAgentName(draft.agent) &&
    (draft.model === null || typeof draft.model === "string") &&
    typeof draft.branch === "string" &&
    typeof draft.branchIsExplicit === "boolean" &&
    isWorkspaceMode(draft.workspaceMode) &&
    (draft.workspaceModeConfirmedFor === null ||
      typeof draft.workspaceModeConfirmedFor === "string") &&
    typeof draft.defaultBranch === "string" &&
    typeof draft.planMode === "boolean" &&
    typeof draft.selfDestruct === "boolean" &&
    typeof draft.selfDestructConditions === "string" &&
    Array.isArray(draft.steps) &&
    draft.steps.every((step) => typeof step === "string") &&
    (draft.trackerUrl === null || typeof draft.trackerUrl === "string") &&
    (draft.sessionMode === null || typeof draft.sessionMode === "string")
  );
}

export function readSpawnDraft(
  storage: Storage | null = browserStorage(),
  now = Date.now(),
): SpawnDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SPAWN_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSpawnDraft(parsed, now)) {
      storage.removeItem(SPAWN_DRAFT_STORAGE_KEY);
      return null;
    }
    const { version: _version, savedAt: _savedAt, ...draft } = parsed;
    return draft;
  } catch {
    try {
      storage.removeItem(SPAWN_DRAFT_STORAGE_KEY);
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
  if (!storage) return;
  try {
    storage.setItem(
      SPAWN_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...draft, version: SPAWN_DRAFT_VERSION, savedAt: now }),
    );
  } catch {
    // Draft persistence must not block spawning when storage is unavailable.
  }
}

export function clearSpawnDraft(storage: Storage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(SPAWN_DRAFT_STORAGE_KEY);
  } catch {
    // Draft cleanup must not block a confirmed spawn.
  }
}
