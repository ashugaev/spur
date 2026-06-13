import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface ConductorSpawnBody {
  prompt?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ConductorSpawnBody;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const payload = prompt ? { prompt } : {};
    const session = await spurRequestJson<SpurSessionView>(
      "/conductor/spawn",
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Spur conductor";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
