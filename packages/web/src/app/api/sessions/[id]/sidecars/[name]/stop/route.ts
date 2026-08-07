import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string; name: string }>;
}

export async function POST(_: Request, context: RouteContext) {
  const { id, name } = await context.params;
  try {
    const session = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/sidecars/${encodeURIComponent(name)}/stop`,
      spurJsonInit("POST"),
    );
    return NextResponse.json(session);
  } catch (error) {
    return spurErrorResponse(error, "Failed to stop Spur sidecar");
  }
}
