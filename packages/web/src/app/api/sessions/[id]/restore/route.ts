import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const result = await spurRequestJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(id)}/restore`,
      spurJsonInit("POST"),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restore Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

