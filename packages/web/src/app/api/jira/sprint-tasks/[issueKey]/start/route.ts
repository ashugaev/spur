import { handleJiraSprintTaskStart } from "../../start-handler";

export const dynamic = "force-dynamic";

/** POST /api/jira/sprint-tasks/:issueKey/start — key-scoped task start endpoint. */
export async function POST(
  request: Request,
  context: { params: Promise<{ issueKey: string }> },
) {
  const { issueKey } = await context.params;
  return handleJiraSprintTaskStart(request, issueKey);
}
