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

function isSilentPreflightFailure(message: string): boolean {
  return (
    message.startsWith("preflight branch ") ||
    message.startsWith("Spawn preflight must return exactly one branch name")
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as PreflightBody;
    const project = body.projectId?.trim();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!project) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const payload: Record<string, unknown> = { project, prompt };
    if (body.agent) payload.agent = body.agent;
    if (body.overrides && Object.keys(body.overrides).length > 0)
      payload.overrides = body.overrides;

    const result = await spurRequestJson<{ branch: string | null }>(
      `/projects/${encodeURIComponent(project)}/preflight`,
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run preflight";
    if (isSilentPreflightFailure(message)) {
      return NextResponse.json({ branch: null });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
