import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { SpurUpdateSessionSlotsResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Guards against an older daemon replying with a plain SessionView (no
// slotUpdate) despite the compile-time SpurUpdateSessionSlotsResponse type —
// mirrors v2/src/cli.ts's slotUpdateMessage narrowing.
function titleResultOf(session: unknown): string | undefined {
  if (!session || typeof session !== "object" || !("slotUpdate" in session)) {
    return undefined;
  }
  const slotUpdate = (session as { slotUpdate?: unknown }).slotUpdate;
  if (!slotUpdate || typeof slotUpdate !== "object" || !("titleResult" in slotUpdate)) {
    return undefined;
  }
  const titleResult = (slotUpdate as { titleResult?: unknown }).titleResult;
  return typeof titleResult === "string" ? titleResult : undefined;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("title" in body)) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  const rawTitle = (body as { title?: unknown }).title;

  let payload: { title: string; source: "manual" } | { clearTitle: true; source: "manual" };
  let wantsClear: boolean;
  if (rawTitle === null) {
    payload = { clearTitle: true, source: "manual" };
    wantsClear = true;
  } else if (typeof rawTitle === "string") {
    const trimmed = rawTitle.trim();
    if (!trimmed) {
      return NextResponse.json(
        { error: "title must not be empty; send title: null to clear" },
        { status: 400 },
      );
    }
    payload = { title: trimmed, source: "manual" };
    wantsClear = false;
  } else {
    return NextResponse.json({ error: "title must be a string or null" }, { status: 400 });
  }

  try {
    const result = await spurRequestJson<SpurUpdateSessionSlotsResponse>(
      `/sessions/${encodeURIComponent(id)}/slots`,
      spurJsonInit("POST", payload),
    );
    const titleResult = titleResultOf(result);
    if (titleResult !== undefined) {
      const expected = wantsClear ? "cleared" : "updated";
      if (titleResult !== expected) {
        return NextResponse.json(
          { error: result.slotUpdate.message ?? "Title was not updated" },
          { status: 409 },
        );
      }
    }
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to update session title");
  }
}
