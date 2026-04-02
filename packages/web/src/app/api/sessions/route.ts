import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView, SpurSessionsResponse } from "@/lib/types";
import { readSpurProjectOptions } from "@/lib/spur-projects";

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("project")?.trim();
    const sessions = await spurRequestJson<SpurSessionView[]>("/sessions");
    const filtered = projectId ? sessions.filter((session) => session.project === projectId) : sessions;
    return NextResponse.json({
      sessions: filtered,
      projects: readSpurProjectOptions(),
    } satisfies SpurSessionsResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Spur sessions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
