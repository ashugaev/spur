import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
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
    return spurErrorResponse(error, "Failed to load session slash commands");
  }
}
