import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AgentSuggestionsResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const agent = request.nextUrl.searchParams.get("agent")?.trim();
  const query = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  try {
    const payload = await spurRequestJson<AgentSuggestionsResponse>(
      `/projects/${encodeURIComponent(id)}/slash-commands${query}`,
    );
    return NextResponse.json(payload);
  } catch (error) {
    return spurErrorResponse(error, "Failed to load project slash commands");
  }
}
