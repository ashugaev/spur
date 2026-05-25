import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { AgentName } from "@/lib/agents";
import type { SpawnOverrides } from "@/lib/types";

interface PreflightBody {
  projectId?: string;
  prompt?: string;
  agent?: AgentName;
  overrides?: SpawnOverrides;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as PreflightBody;
    const projectId = body.projectId?.trim();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const overrides =
      body.overrides && Object.keys(body.overrides).length > 0 ? body.overrides : undefined;
    const payload: Record<string, unknown> = { prompt };
    if (body.agent) payload.agent = body.agent;
    if (overrides) payload.overrides = overrides;

    const preflight = await spurRequestJson<{ branch: string | null }>(
      `/projects/${encodeURIComponent(projectId)}/preflight`,
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(preflight);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run preflight";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
