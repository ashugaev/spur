import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { AgentSuggestionsResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const payload = await spurRequestJson<AgentSuggestionsResponse>(
      `/sessions/${encodeURIComponent(id)}/slash-commands`,
    );
    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load session slash commands";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
