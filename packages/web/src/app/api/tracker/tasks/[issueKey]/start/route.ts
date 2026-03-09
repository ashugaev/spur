import { handleJiraSprintTaskStart } from "@/app/api/jira/sprint-tasks/start-handler";

export const dynamic = "force-dynamic";

/** POST /api/tracker/tasks/:issueKey/start — key-scoped tracker task start endpoint. */
export async function POST(
  request: Request,
  context: { params: Promise<{ issueKey: string }> },
) {
  const { issueKey } = await context.params;
  return handleJiraSprintTaskStart(request, issueKey);
}
