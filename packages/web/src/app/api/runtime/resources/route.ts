import { NextResponse } from "next/server";
import { readResourceSnapshot } from "@/lib/resource-monitoring";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const resourceSnapshot = await readResourceSnapshot();

  return NextResponse.json(resourceSnapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
