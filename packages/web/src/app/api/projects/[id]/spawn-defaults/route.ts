import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import { AGENT_OPTIONS } from "@/lib/agents";
import type { SpawnDefaultsResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const agent = request.nextUrl.searchParams.get("agent")?.trim() ?? "";
  if (!(AGENT_OPTIONS as readonly string[]).includes(agent)) {
    return NextResponse.json({ error: `Unsupported agent: ${agent}` }, { status: 400 });
  }
  try {
    const payload = await spurRequestJson<SpawnDefaultsResponse>(
      `/projects/${encodeURIComponent(id)}/spawn-defaults?agent=${encodeURIComponent(agent)}`,
    );
    return NextResponse.json(payload);
  } catch (error) {
    return spurErrorResponse(error, "Failed to load spawn defaults");
  }
}
