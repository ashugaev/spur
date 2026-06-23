import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string; name: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, name } = await context.params;
  try {
    const result = await spurRequestJson<{ ok: true; matchedRules: unknown[] }>(
      `/sessions/${encodeURIComponent(id)}/sidecars/${encodeURIComponent(name)}/report-failure`,
      { method: "POST" },
    );
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to report Spur sidecar failure";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
