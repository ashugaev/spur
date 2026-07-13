import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { SpurSessionView } from "@/lib/types";

interface ShepherdSpawnBody {
  prompt?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ShepherdSpawnBody;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const payload = prompt ? { prompt } : {};
    const session = await spurRequestJson<SpurSessionView>(
      "/shepherd/spawn",
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return spurErrorResponse(error, "Failed to start Spur Shepherd");
  }
}
