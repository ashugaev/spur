import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { buildJiraSprintTasksSnapshot } from "@/lib/jira-sprint-tasks";
import { handleJiraSprintTaskStart } from "@/app/api/jira/sprint-tasks/start-handler";
import type { JiraSprintTasksSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/tracker/tasks — tracker tasks from active tracker-task listeners. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedProjectId = searchParams.get("projectId")?.trim();
  const envProjectId = process.env["AO_PROJECT_ID"]?.trim();
  const projectId = requestedProjectId || envProjectId || undefined;

  try {
    const { config, registry, sessionManager } = await getServices();
    const snapshot: JiraSprintTasksSnapshot = await buildJiraSprintTasksSnapshot({
      config,
      registry,
      sessionManager,
      projectId,
    });

    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load tracker tasks" },
      { status: 500 },
    );
  }
}

/** POST /api/tracker/tasks — Start a session for a tracker task. */
export async function POST(request: Request) {
  return handleJiraSprintTaskStart(request);
}
