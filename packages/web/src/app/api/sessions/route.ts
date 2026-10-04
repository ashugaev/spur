import { jsonResponse } from "@/lib/json-response";
import { SpurDaemonError, spurRequest, spurRequestJson } from "@/lib/spur-daemon";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { readLifecycleSnapshot } from "@/lib/session-lifecycle";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type {
  AvailableBacklogItem,
  ProjectInfo,
  SpurSessionView,
  SpurSessionsResponse,
} from "@/lib/types";

export async function GET(request: Request) {
  try {
    const [response, projects, backlog] = await Promise.all([
      spurRequest("/sessions?includeCompleted=1&view=dashboard"),
      spurRequestJson<ProjectInfo[]>("/projects"),
      spurRequestJson<AvailableBacklogItem[]>("/backlog/available"),
    ]);
    const payload = await readResponsePayload(response);
    if (!response.ok)
      throw new SpurDaemonError(
        responseErrorMessage(payload, "Failed to list Spur sessions"),
        response.status,
        payload,
      );
    const lifecycleInstanceId = response.headers.get("x-spur-lifecycle-instance-id");
    if (
      !lifecycleInstanceId?.trim() ||
      !Array.isArray(payload) ||
      payload.some(
        (row: unknown) =>
          typeof row !== "object" ||
          row === null ||
          !("lifecycle" in row) ||
          readLifecycleSnapshot(row.lifecycle)?.instanceId !== lifecycleInstanceId,
      )
    ) {
      throw new Error("Invalid session lifecycle identity");
    }
    const sessions = payload as SpurSessionView[];
    return await jsonResponse(request, {
      lifecycleInstanceId,
      sessions,
      projects,
      backlog,
      daemonAlive: true,
    } satisfies SpurSessionsResponse);
  } catch (error) {
    return spurErrorResponse(error, "Failed to list Spur sessions");
  }
}
