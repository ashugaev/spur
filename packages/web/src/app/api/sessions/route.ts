import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type {
  AvailableBacklogItem,
  ProjectInfo,
  SpurSessionView,
  SpurSessionsResponse,
} from "@/lib/types";

export async function GET() {
  try {
    const [sessions, projects, backlog] = await Promise.all([
      spurRequestJson<SpurSessionView[]>("/sessions?includeCompleted=1&view=dashboard"),
      spurRequestJson<ProjectInfo[]>("/projects"),
      spurRequestJson<AvailableBacklogItem[]>("/backlog/available"),
    ]);
    return NextResponse.json({
      sessions,
      projects,
      backlog,
      daemonAlive: true,
    } satisfies SpurSessionsResponse);
  } catch (error) {
    return spurErrorResponse(error, "Failed to list Spur sessions");
  }
}
