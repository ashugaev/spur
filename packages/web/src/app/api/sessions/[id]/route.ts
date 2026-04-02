import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const session = await spurRequestJson<SpurSessionView>(`/sessions/${encodeURIComponent(id)}`);
    return NextResponse.json(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
