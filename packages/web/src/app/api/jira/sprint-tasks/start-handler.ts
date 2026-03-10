import { NextResponse } from "next/server";
import { sessionToDashboard } from "@/lib/serialize";
import { getServices } from "@/lib/services";

interface StartPayload {
  issueKey: string;
  projectId?: string;
  listenerId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

async function readStartPayload(request: Request, issueKeyFromPath?: string): Promise<StartPayload> {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => null)) as unknown;

  if (body !== null && !isRecord(body)) {
    throw new Error("Invalid JSON body");
  }

  const payload = isRecord(body) ? body : {};

  const issueKey =
    issueKeyFromPath?.trim() ||
    readString(payload, ["issueKey", "key", "taskKey", "id", "issueId"]) ||
    url.searchParams.get("issueKey")?.trim() ||
    url.searchParams.get("key")?.trim();

  if (!issueKey) {
    throw new Error("issueKey is required");
  }

  const projectId =
    readString(payload, ["projectId"]) || url.searchParams.get("projectId")?.trim() || undefined;

  const listenerId =
    readString(payload, ["listenerId"]) || url.searchParams.get("listenerId")?.trim() || undefined;

  return {
    issueKey,
    projectId,
    listenerId,
  };
}

function toErrorResponse(err: unknown, fallback: string): Response {
  const typed = err as { message?: unknown; status?: unknown; code?: unknown; details?: unknown };
  const message = typeof typed.message === "string" ? typed.message : fallback;
  const status = typeof typed.status === "number" ? typed.status : 500;
  const code = typeof typed.code === "string" ? typed.code : undefined;
  const details = isRecord(typed.details) ? typed.details : undefined;

  return NextResponse.json(
    {
      error: message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export async function handleJiraSprintTaskStart(
  request: Request,
  issueKeyFromPath?: string,
): Promise<Response> {
  let payload: StartPayload;
  try {
    payload = await readStartPayload(request, issueKeyFromPath);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    const { config, registry, sessionManager } = await getServices();
    const jiraSprintTasks = await import("@/lib/jira-sprint-tasks");

    const result = await jiraSprintTasks.startJiraSprintTask({
      config,
      registry,
      sessionManager,
      issueKey: payload.issueKey,
      projectId: payload.projectId,
      listenerId: payload.listenerId,
    });

    if (result.kind === "spawned") {
      return NextResponse.json(
        {
          started: true,
          duplicate: false,
          issueKey: result.issueKey,
          projectId: result.projectId,
          listenerId: result.listenerId,
          session: sessionToDashboard(result.session),
        },
        { status: 201 },
      );
    }

    if (result.kind === "already-active") {
      return NextResponse.json(
        {
          started: false,
          duplicate: true,
          issueKey: result.issueKey,
          projectId: result.projectId,
          listenerId: result.listenerId,
          session: sessionToDashboard(result.session),
          error: `Active session already exists for ${result.issueKey}`,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        started: false,
        duplicate: false,
        issueKey: result.issueKey,
        projectId: result.projectId,
        listenerId: result.listenerId,
        error: `Start for ${result.issueKey} is already in progress`,
      },
      { status: 409 },
    );
  } catch (err) {
    return toErrorResponse(err, "Failed to start tracker task");
  }
}
