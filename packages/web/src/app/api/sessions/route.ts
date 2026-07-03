import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type {
  ProjectInfo,
  SpurSessionView,
  SpurSessionsResponse,
  SpurTagDefinition,
} from "@/lib/types";

export async function GET() {
  try {
    const [sessions, projects, info] = await Promise.all([
      spurRequestJson<SpurSessionView[]>("/sessions?includeCompleted=1&view=dashboard"),
      spurRequestJson<ProjectInfo[]>("/projects"),
      spurRequestJson<{ tags?: SpurTagDefinition[] }>("/info"),
    ]);
    return NextResponse.json({
      sessions,
      projects,
      tags: info.tags ?? [],
      daemonAlive: true,
    } satisfies SpurSessionsResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Spur sessions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
