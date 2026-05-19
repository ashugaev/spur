import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RespawnBody {
  prompt?: string;
  attachments?: Array<{ name: string; data: string }>;
  startupAttachmentIds?: string[];
  terminateSessionId?: string;
  forceKillSource?: boolean;
  agent?: AgentName;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as RespawnBody;
    const payload: Record<string, unknown> = {};
    if (typeof body.prompt === "string") payload.prompt = body.prompt;
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      payload.attachments = body.attachments;
    }
    if (Array.isArray(body.startupAttachmentIds)) {
      payload.startupAttachmentIds = body.startupAttachmentIds;
    }
    if (typeof body.forceKillSource === "boolean" && body.forceKillSource) {
      payload.forceKillSource = true;
    }
    if (typeof body.terminateSessionId === "string" && body.terminateSessionId.trim().length > 0) {
      payload.terminateSessionId = body.terminateSessionId.trim();
    }
    if (
      typeof body.agent === "string" &&
      (AGENT_OPTIONS as readonly string[]).includes(body.agent)
    ) {
      payload.agent = body.agent;
    }
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/respawn`,
      spurJsonInit("POST", Object.keys(payload).length > 0 ? payload : undefined),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to respawn Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
