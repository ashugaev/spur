import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AutoUpdateBody {
  enabled?: unknown;
}

export async function POST(request: NextRequest) {
  let body: AutoUpdateBody;
  try {
    body = (await request.json()) as AutoUpdateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled;
  try {
    const daemonResponse = await spurRequest(
      "/deploy/auto-update",
      spurJsonInit("POST", { enabled }),
    );
    const text = await daemonResponse.text();
    const payload: unknown = text ? JSON.parse(text) : {};
    return NextResponse.json(payload, { status: daemonResponse.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update autoUpdate setting";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
