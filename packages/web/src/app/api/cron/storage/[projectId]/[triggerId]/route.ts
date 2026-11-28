import { NextResponse } from "next/server";
import { cronStorageDaemonPath } from "@/lib/cron-jobs";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { CronStorageView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ projectId: string; triggerId: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { projectId, triggerId } = await context.params;
  try {
    return NextResponse.json(
      await spurRequestJson<CronStorageView>(cronStorageDaemonPath(projectId, triggerId), {
        timeoutMs: 10_000,
      }),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to load cron storage");
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  const { projectId, triggerId } = await context.params;
  try {
    return NextResponse.json(
      await spurRequestJson<CronStorageView>(cronStorageDaemonPath(projectId, triggerId), {
        method: "DELETE",
      }),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to clear cron storage");
  }
}
