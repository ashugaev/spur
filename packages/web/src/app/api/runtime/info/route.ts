import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const info = await spurRequestJson<unknown>("/info");
    return NextResponse.json(info, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read runtime info";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
