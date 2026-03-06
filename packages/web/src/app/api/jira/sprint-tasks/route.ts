import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { buildJiraSprintTasksSnapshot } from "@/lib/jira-sprint-tasks";
import { handleJiraSprintTaskStart } from "./start-handler";
import type { JiraSprintTasksSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/jira/sprint-tasks — Jira tasks from active jira-backlog listeners. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedProjectId = searchParams.get("projectId")?.trim();
  const envProjectId = process.env["AO_PROJECT_ID"]?.trim();
  const projectId = requestedProjectId || envProjectId || undefined;

  try {
    const { config, sessionManager } = await getServices();
    const snapshot: JiraSprintTasksSnapshot = await buildJiraSprintTasksSnapshot({
      config,
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
      { error: err instanceof Error ? err.message : "Failed to load Jira sprint tasks" },
      { status: 500 },
    );
  }
}

/** POST /api/jira/sprint-tasks — Start a session for a Jira sprint task. */
export async function POST(request: Request) {
  return handleJiraSprintTaskStart(request);
}

