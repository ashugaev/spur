import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthAlertsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await spurRequestJson<AuthAlertsResponse>("/auth-alerts"));
  } catch (error) {
    return spurErrorResponse(error, "Failed to list sign-in alerts");
  }
}
