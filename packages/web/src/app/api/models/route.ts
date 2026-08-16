import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import { AGENT_OPTIONS } from "@/lib/agents";
import type { AgentModelsResponse } from "@/lib/types";

export async function GET(request: NextRequest) {
  const agent = request.nextUrl.searchParams.get("agent")?.trim() ?? "";
  if (!(AGENT_OPTIONS as readonly string[]).includes(agent)) {
    return NextResponse.json({ error: `Unsupported agent: ${agent}` }, { status: 400 });
  }
  try {
    // cursor's catalog request shells out to `cursor models`, which has its
    // own timeout but can still stall on a hung/misconfigured CLI; bound the
    // whole daemon round trip so the picker settles into an error instead of
    // staying unresolved (and submit disabled) indefinitely.
    const payload = await spurRequestJson<AgentModelsResponse>(
      `/models?agent=${encodeURIComponent(agent)}`,
      { timeoutMs: 8_000 },
    );
    return NextResponse.json(payload);
  } catch (error) {
    return spurErrorResponse(error, "Failed to load models");
  }
}
