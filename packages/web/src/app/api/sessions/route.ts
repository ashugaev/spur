import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView, SpurSessionsResponse } from "@/lib/types";

export async function GET() {
  try {
    const [sessions, projects] = await Promise.all([
      spurRequestJson<SpurSessionView[]>("/sessions?includeCompleted=1&view=dashboard"),
      spurRequestJson<Array<{ id: string; name: string }>>("/projects"),
    ]);
    return NextResponse.json({
      sessions,
      projects,
      daemonAlive: true,
    } satisfies SpurSessionsResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Spur sessions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
