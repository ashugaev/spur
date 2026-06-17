import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { AvailableBacklogItem, SpurSessionView, SpurSessionsResponse } from "@/lib/types";

export async function GET() {
  try {
    const [sessions, projects, backlog] = await Promise.all([
      spurRequestJson<SpurSessionView[]>("/sessions?includeCompleted=1&view=dashboard"),
      spurRequestJson<Array<{ id: string; name: string }>>("/projects"),
      spurRequestJson<AvailableBacklogItem[]>("/backlog/available"),
    ]);
    return NextResponse.json({
      sessions,
      projects,
      backlog,
    } satisfies SpurSessionsResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Spur sessions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
