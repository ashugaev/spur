import { NextResponse } from "next/server";
import { readResourceSnapshot } from "@/lib/resource-monitoring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await readResourceSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
