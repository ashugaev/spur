import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { AGENT_OPTIONS } from "@/lib/agents";
import type { AgentModelsResponse } from "@/lib/types";

export async function GET(request: NextRequest) {
  const agent = request.nextUrl.searchParams.get("agent")?.trim() ?? "";
  if (!(AGENT_OPTIONS as readonly string[]).includes(agent)) {
    return NextResponse.json({ error: `Unsupported agent: ${agent}` }, { status: 400 });
  }
  try {
    const payload = await spurRequestJson<AgentModelsResponse>(
      `/models?agent=${encodeURIComponent(agent)}`,
    );
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
