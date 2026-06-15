import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { AgentName } from "@/lib/agents";
import type { SpawnOverrides, SpurSessionView } from "@/lib/types";

interface SelfDestructBody {
  enabled: boolean;
  conditions?: string;
}

interface SpawnBody {
  projectId?: string;
  prompt?: string;
  agent?: AgentName;
  attachments?: Array<{ name: string; data: string }>;
  branch?: string;
  planMode?: boolean;
  steps?: string[];
  overrides?: SpawnOverrides;
  reuseWorkspaceSessionId?: string;
  bootstrap?: boolean;
  selfDestruct?: SelfDestructBody;
}

function normalizeSelfDestruct(value: SelfDestructBody | undefined): SelfDestructBody | undefined {
  if (!value || typeof value.enabled !== "boolean") {
    return undefined;
  }
  const conditions = typeof value.conditions === "string" ? value.conditions.trim() : "";
  return {
    enabled: value.enabled,
    ...(conditions ? { conditions } : {}),
  };
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
    const selfDestruct = normalizeSelfDestruct(body.selfDestruct);

    const payload: Record<string, unknown> = { project, prompt };
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      payload.attachments = body.attachments;
    }
    if (body.agent) payload.agent = body.agent;
    if (body.branch?.trim()) payload.branch = body.branch.trim();
    if (body.planMode === true) payload.planMode = true;
    if (filteredSteps && filteredSteps.length > 0) payload.steps = filteredSteps;
    if (overrides) payload.overrides = overrides;
    if (selfDestruct) payload.selfDestruct = selfDestruct;
    const reuseId = body.reuseWorkspaceSessionId?.trim();
    if (reuseId) payload.reuseWorkspaceSessionId = reuseId;
    if (body.bootstrap === true) payload.bootstrap = true;

    const session = await spurRequestJson<SpurSessionView>(
      "/sessions/background",
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
