import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const info = await spurRequestJson<unknown>("/info");
    return NextResponse.json(info, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return spurErrorResponse(error, "Failed to read runtime info");
  }
}
