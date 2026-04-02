import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface KillBody {
  force?: boolean;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as KillBody;
    const result = await spurRequestJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(id)}/kill`,
      spurJsonInit("POST", { force: body.force === true }),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to kill Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
