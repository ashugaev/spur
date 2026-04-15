import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string; name: string }>;
}

export async function POST(_: Request, context: RouteContext) {
  const { id, name } = await context.params;
  try {
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/sidecars/${encodeURIComponent(name)}/stop`,
      spurJsonInit("POST"),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stop Spur sidecar";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
