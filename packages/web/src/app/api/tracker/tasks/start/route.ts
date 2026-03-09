import { handleJiraSprintTaskStart } from "@/app/api/jira/sprint-tasks/start-handler";

export const dynamic = "force-dynamic";

/** POST /api/tracker/tasks/start — legacy alias for tracker task start. */
export async function POST(request: Request) {
  return handleJiraSprintTaskStart(request);
}
