import { handleJiraSprintTaskStart } from "../start-handler";

export const dynamic = "force-dynamic";

/** POST /api/jira/sprint-tasks/start — legacy alias for task start. */
export async function POST(request: Request) {
  return handleJiraSprintTaskStart(request);
}
