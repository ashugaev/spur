import { NextResponse } from "next/server";
import { isSpurDaemonError } from "@/lib/spur-daemon";

// Map a daemon-client failure to an HTTP response, preserving the daemon's real
// status (e.g. a 400 validation error) instead of flattening everything to 502.
export function spurErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = isSpurDaemonError(error) ? error.status : 502;
  return NextResponse.json({ error: message }, { status });
}
