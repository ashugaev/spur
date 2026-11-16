import type {
  SessionRecord,
  SessionState,
  TaskStatusDeclaration,
  TaskStatusRequest,
  TaskStatusView,
} from "./types.js";

export class TaskStatusError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 409,
    readonly code: "invalid_task_status" | "task_status_forbidden" | "stale_task_status",
  ) {
    super(message);
  }
}

export function isTaskStatusRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTaskStatusRequest(value: unknown): TaskStatusRequest {
  if (
    !isRecord(value) ||
    (value.state !== "completed" && value.state !== "needs_input" && value.state !== "clear") ||
    !isTaskStatusRevision(value.revision) ||
    typeof value.agentLaunchId !== "string" ||
    !value.agentLaunchId.trim()
  ) {
    throw new TaskStatusError(
      "Expected state, nonnegative integer revision and agentLaunchId",
      400,
      "invalid_task_status",
    );
  }
  return { state: value.state, revision: value.revision, agentLaunchId: value.agentLaunchId };
}

export function normalizeTaskStatus(value: unknown): TaskStatusDeclaration | undefined {
  if (
    !isRecord(value) ||
    (value.state !== "completed" && value.state !== "needs_input") ||
    !isTaskStatusRevision(value.revision) ||
    typeof value.agentLaunchId !== "string" ||
    !value.agentLaunchId.trim() ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    return undefined;
  return {
    state: value.state,
    revision: value.revision,
    agentLaunchId: value.agentLaunchId,
    updatedAt: value.updatedAt,
  };
}

type TaskStatusRecord = Pick<
  SessionRecord,
  "status" | "agentLaunchId" | "taskStatusRevision" | "taskStatus"
>;

export function readTaskStatus(session: TaskStatusRecord): TaskStatusView {
  const revision = session.taskStatusRevision ?? 0;
  const declaration = session.taskStatus;
  return {
    revision,
    ...(session.status === "running" &&
    declaration &&
    declaration.agentLaunchId === session.agentLaunchId &&
    declaration.revision === revision
      ? { state: declaration.state }
      : {}),
  };
}

export function clearTaskStatus(session: SessionRecord, advanceRevision = false): SessionRecord {
  const { taskStatus: _taskStatus, ...record } = session;
  if (!advanceRevision) return record;
  const revision = (session.taskStatusRevision ?? 0) + 1;
  if (!isTaskStatusRevision(revision))
    throw new TaskStatusError("Task revision exhausted", 409, "stale_task_status");
  return { ...record, taskStatusRevision: revision };
}

export function projectTaskStatus(
  session: TaskStatusRecord,
  raw: SessionState,
  stabilized: SessionState,
  runtimeAlive: boolean,
  workspacePresent: boolean,
): SessionState {
  const declaration = readTaskStatus(session).state;
  if (!declaration || !runtimeAlive || !workspacePresent) return stabilized;
  // An idle-state hold must never let a task declaration hide new native work.
  if (raw !== "waiting") return raw;
  return stabilized === "waiting" ? declaration : stabilized;
}
