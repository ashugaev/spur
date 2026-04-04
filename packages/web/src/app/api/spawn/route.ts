import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface SpawnBody {
  projectId?: string;
  prompt?: string;
  agent?: "claude" | "codex";
  branch?: string;
  planMode?: boolean;
  steps?: string[];
  overrides?: { worktree?: boolean; defaultBranch?: string };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SpawnBody;
    const project = body.projectId?.trim();
    const prompt = body.prompt?.trim();

    if (!project) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const filteredSteps = Array.isArray(body.steps)
      ? body.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
      : undefined;

    const rawOverrides =
      typeof body.overrides === "object" && body.overrides !== null ? body.overrides : undefined;
    const overrides =
      rawOverrides && Object.keys(rawOverrides).length > 0 ? rawOverrides : undefined;

    const payload: Record<string, unknown> = { project, prompt };
    if (body.agent) payload.agent = body.agent;
    if (body.branch?.trim()) payload.branch = body.branch.trim();
    if (body.planMode === true) payload.planMode = true;
    if (filteredSteps && filteredSteps.length > 0) payload.steps = filteredSteps;
    if (overrides) payload.overrides = overrides;

    const session = await spurRequestJson<SpurSessionView>(
      "/sessions",
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
