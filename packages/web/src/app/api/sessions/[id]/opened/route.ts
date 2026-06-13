import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/opened`,
      spurJsonInit("POST"),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark Spur session opened";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
