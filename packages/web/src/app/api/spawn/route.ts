import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AgentName } from "@/lib/agents";
import type { SpawnOverrides, SpurSessionView } from "@/lib/types";

interface SpawnBody {
  projectId?: string;
  prompt?: string;
  agent?: AgentName;
  model?: string;
  attachments?: Array<{ name: string; data: string }>;
  branch?: string;
  planMode?: boolean;
  steps?: string[];
  overrides?: SpawnOverrides;
  selfDestruct?: { enabled: boolean; conditions?: string };
  reuseWorkspaceSessionId?: string;
  babysitterOf?: string;
  bootstrap?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SpawnBody;
    const project = body.projectId?.trim();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!project) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const filteredSteps = Array.isArray(body.steps)
      ? body.steps
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
      : undefined;

    const overrides =
      body.overrides && Object.keys(body.overrides).length > 0 ? body.overrides : undefined;

    const payload: Record<string, unknown> = { project, prompt };
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      payload.attachments = body.attachments;
    }
    if (body.agent) payload.agent = body.agent;
    if (body.model?.trim()) payload.model = body.model.trim();
    if (body.branch?.trim()) payload.branch = body.branch.trim();
    if (body.planMode === true) payload.planMode = true;
    if (body.selfDestruct) payload.selfDestruct = body.selfDestruct;
    if (filteredSteps && filteredSteps.length > 0) payload.steps = filteredSteps;
    if (overrides) payload.overrides = overrides;
    const reuseId = body.reuseWorkspaceSessionId?.trim();
    if (reuseId) payload.reuseWorkspaceSessionId = reuseId;
    const babysitterOf = body.babysitterOf?.trim();
    if (babysitterOf) payload.babysitterOf = babysitterOf;
    if (body.bootstrap === true) payload.bootstrap = true;

    const session = await spurRequestJson<SpurSessionView>(
      "/sessions/background",
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return spurErrorResponse(error, "Failed to spawn Spur session");
  }
}
