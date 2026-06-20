import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || !("title" in body)) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }
    const rawTitle = (body as { title?: unknown }).title;
    if (rawTitle !== null && typeof rawTitle !== "string") {
      return NextResponse.json({ error: "title must be a string or null" }, { status: 400 });
    }
    const title = rawTitle?.trim() ?? "";
    const payload = title ? { title, source: "manual" } : { clearTitle: true, source: "manual" };
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/slots`,
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update session title";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
