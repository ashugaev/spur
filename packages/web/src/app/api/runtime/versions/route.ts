import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const payload = await spurRequestJson<unknown>("/deploy/versions");
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read runtime versions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
