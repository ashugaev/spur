import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface PreflightBody {
  projectId?: string;
  prompt?: string;
  agent?: "claude" | "codex";
  overrides?: { worktree?: boolean; defaultBranch?: string };
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
    const rawOverrides =
      typeof body.overrides === "object" && body.overrides !== null ? body.overrides : undefined;
    if (rawOverrides && Object.keys(rawOverrides).length > 0) payload.overrides = rawOverrides;

    const result = await spurRequestJson<{ branch: string | null }>(
      `/projects/${encodeURIComponent(project)}/preflight`,
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run preflight";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
