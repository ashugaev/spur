import { NextResponse, type NextRequest } from "next/server";
import { isSpurDaemonError, spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { CronJobEditDraft, CronJobEditResult } from "@/lib/types";

function daemonPath(request: NextRequest): string {
  const query = new URLSearchParams();
  for (const name of ["project", "source", "trigger"]) {
    query.set(name, request.nextUrl.searchParams.get(name)?.trim() ?? "");
  }
  return `/projects/cron/edit?${query}`;
}

function editorErrorResponse(error: unknown): NextResponse {
  if (isSpurDaemonError(error) && typeof error.payload === "object" && error.payload !== null) {
    const payload = error.payload as { code?: unknown; field?: unknown };
    return NextResponse.json(
      {
        error: error.message,
        ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        ...(typeof payload.field === "string" ? { field: payload.field } : {}),
      },
      { status: error.status },
    );
  }
  return spurErrorResponse(error, "Could not edit cron job");
}

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(
      await spurRequestJson<CronJobEditDraft>(daemonPath(request), { timeoutMs: 10_000 }),
    );
  } catch (error) {
    return editorErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid editor JSON body." }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await spurRequestJson<CronJobEditResult>(daemonPath(request), spurJsonInit("PATCH", body)),
    );
  } catch (error) {
    return editorErrorResponse(error);
  }
}
