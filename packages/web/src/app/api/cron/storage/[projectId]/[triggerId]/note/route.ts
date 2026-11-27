import { NextResponse, type NextRequest } from "next/server";
import { cronStorageDaemonPath } from "@/lib/cron-jobs";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { CronStorageView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ projectId: string; triggerId: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { projectId, triggerId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid note JSON body." }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await spurRequestJson<CronStorageView>(
        `${cronStorageDaemonPath(projectId, triggerId)}/note`,
        spurJsonInit("PATCH", body),
      ),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to save cron storage note");
  }
}
