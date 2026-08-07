import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { SpurTagDefinition } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const info = await spurRequestJson<{ tags?: SpurTagDefinition[] }>("/info");
    return NextResponse.json(
      { tags: info.tags ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to read tag catalog");
  }
}
