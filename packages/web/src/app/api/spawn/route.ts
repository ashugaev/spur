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

    const filteredSteps = body.steps
      ?.map((s) => s.trim())
      .filter((s) => s.length > 0);

    const overrides =
      body.overrides && Object.keys(body.overrides).length > 0
        ? body.overrides
        : undefined;

    const session = await spurRequestJson<SpurSessionView>(
      "/sessions",
      spurJsonInit("POST", {
        project,
        prompt,
        ...(body.agent ? { agent: body.agent } : {}),
        ...(body.branch?.trim() ? { branch: body.branch.trim() } : {}),
        ...(body.planMode === true ? { planMode: true } : {}),
        ...(filteredSteps && filteredSteps.length > 0 ? { steps: filteredSteps } : {}),
        ...(overrides ? { overrides } : {}),
      }),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
