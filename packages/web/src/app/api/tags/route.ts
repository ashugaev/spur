import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
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
    const message = error instanceof Error ? error.message : "Failed to read tag catalog";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
