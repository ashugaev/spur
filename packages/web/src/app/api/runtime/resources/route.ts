import { NextResponse } from "next/server";
import { readResourceSnapshot } from "@/lib/resource-monitoring";
import { spurRequestJson } from "@/lib/spur-daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const resourceSnapshot = await readResourceSnapshot();

  const daemonAlive = await (async () => {
    try {
      await spurRequestJson("/projects");
      return true;
    } catch {
      return false;
    }
  })();

  return NextResponse.json(
    { ...resourceSnapshot, daemonAlive },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
