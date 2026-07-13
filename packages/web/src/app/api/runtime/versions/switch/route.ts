import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SwitchBody {
  version?: unknown;
}

export async function POST(request: NextRequest) {
  let body: SwitchBody;
  try {
    body = (await request.json()) as SwitchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const version = typeof body.version === "string" ? body.version : "";
  try {
    const daemonResponse = await spurRequest("/deploy/switch", spurJsonInit("POST", { version }));
    const text = await daemonResponse.text();
    const payload: unknown = text ? JSON.parse(text) : {};
    return NextResponse.json(payload, { status: daemonResponse.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to switch Spur version";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
