import { NextResponse } from "next/server";
import { readVoiceStatus } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await readVoiceStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
