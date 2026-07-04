import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface TransferBody {
  note?: string;
  attachments?: Array<{ name: string; data: string }>;
  forceKillSource?: boolean;
  agent?: AgentName;
  model?: string;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as TransferBody;
    const payload: Record<string, unknown> = {};
    if (typeof body.note === "string") payload.note = body.note;
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      payload.attachments = body.attachments;
    }
    if (typeof body.forceKillSource === "boolean" && body.forceKillSource) {
      payload.forceKillSource = true;
    }
    if (
      typeof body.agent === "string" &&
      (AGENT_OPTIONS as readonly string[]).includes(body.agent)
    ) {
      payload.agent = body.agent;
    }
    if (typeof body.model === "string" && body.model.trim().length > 0) {
      payload.model = body.model.trim();
    }
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/transfer`,
      spurJsonInit("POST", Object.keys(payload).length > 0 ? payload : undefined),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to transfer Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
