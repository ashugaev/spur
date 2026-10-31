import { NextResponse } from "next/server";
import { isSpurDaemonError } from "@/lib/spur-daemon";
import { readSpawnBatchConflict } from "@/lib/spawn-batch-conflict";

// Map a daemon-client failure to an HTTP response, preserving the daemon's real
// status (e.g. a 400 validation error) instead of flattening everything to 502.
export function spurErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = isSpurDaemonError(error) ? error.status : 502;
  return NextResponse.json({ error: message }, { status });
}

// Forward a daemon 409 for an already-claimed preflight batch with its code and owner.
export function spawnBatchConflictResponse(error: unknown): NextResponse | null {
  if (!isSpurDaemonError(error) || error.status !== 409) return null;
  const conflict = readSpawnBatchConflict(error.payload);
  if (!conflict) return null;
  return NextResponse.json({ error: error.message, ...conflict }, { status: 409 });
}
