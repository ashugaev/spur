import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { CronJobsResponse } from "@/lib/types";

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project")?.trim() ?? "";
  const path = project ? `/projects/cron?project=${encodeURIComponent(project)}` : "/projects/cron";
  try {
    const payload = await spurRequestJson<CronJobsResponse>(path, { timeoutMs: 10_000 });
    return NextResponse.json(payload);
  } catch (error) {
    return spurErrorResponse(error, "Failed to load cron jobs");
  }
}
