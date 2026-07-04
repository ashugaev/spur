import { NextResponse } from "next/server";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SwitchBody {
  agent?: AgentName;
  model?: string;
  additionalNotes?: string;
  attachments?: Array<{ name: string; data: string }>;
  planMode?: boolean;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as SwitchBody;
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
    if (typeof body.additionalNotes === "string" && body.additionalNotes.trim().length > 0) {
      payload.additionalNotes = body.additionalNotes.trim();
    }
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      payload.attachments = body.attachments;
    }
    if (body.planMode === true) payload.planMode = true;

    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/switch`,
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to switch Spur session agent";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
