import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { UsageReport } from "@/lib/types";

export async function GET() {
  try {
    const payload = await spurRequestJson<UsageReport>("/usage", { timeoutMs: 15_000 });
    return NextResponse.json(payload);
  } catch (error) {
    return spurErrorResponse(error, "Failed to load usage");
  }
}
