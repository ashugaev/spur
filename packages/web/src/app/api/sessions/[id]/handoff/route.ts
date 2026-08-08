import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface HandoffBody {
  agent?: AgentName;
  model?: string;
  notes?: string;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as HandoffBody;
    if (
      typeof body.agent !== "string" ||
      !(AGENT_OPTIONS as readonly string[]).includes(body.agent)
    ) {
      return NextResponse.json({ error: "agent is required" }, { status: 400 });
    }
    const payload: Record<string, unknown> = { agent: body.agent };
    if (typeof body.model === "string" && body.model.trim().length > 0) {
      payload.model = body.model.trim();
    }
    if (typeof body.notes === "string" && body.notes.trim().length > 0) {
      payload.notes = body.notes.trim();
    }
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/handoff`,
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to hand off Spur session");
  }
}
