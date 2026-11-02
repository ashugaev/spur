export interface SpawnBatchConflict {
  code: "spawn_in_progress" | "spawn_committed" | "spawn_failed";
  sessionId: string;
}

const SPAWN_BATCH_CONFLICT_CODES: ReadonlySet<string> = new Set<SpawnBatchConflict["code"]>([
  "spawn_in_progress",
  "spawn_committed",
  "spawn_failed",
]);

function isSpawnBatchConflictCode(code: string): code is SpawnBatchConflict["code"] {
  return SPAWN_BATCH_CONFLICT_CODES.has(code);
}

/** Reads the 409 body for a preflight batch already claimed by a session. */
export function readSpawnBatchConflict(payload: unknown): SpawnBatchConflict | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("code" in payload) ||
    typeof payload.code !== "string" ||
    !isSpawnBatchConflictCode(payload.code) ||
    !("sessionId" in payload) ||
    typeof payload.sessionId !== "string"
  )
    return null;
  return { code: payload.code, sessionId: payload.sessionId };
}
