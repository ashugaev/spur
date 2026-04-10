import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface PreflightBody {
  projectId?: string;
  prompt?: string;
  agent?: "claude" | "codex";
  overrides?: { worktree?: boolean; defaultBranch?: string };
}

interface PreflightResponse {
  branch: string | null;
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

    const rawOverrides =
      typeof body.overrides === "object" && body.overrides !== null ? body.overrides : undefined;
    const overrides =
      rawOverrides && Object.keys(rawOverrides).length > 0 ? rawOverrides : undefined;
    const payload: Record<string, unknown> = { prompt };
    if (body.agent) payload.agent = body.agent;
    if (overrides) payload.overrides = overrides;

    const preflight = await spurRequestJson<PreflightResponse>(
      `/projects/${encodeURIComponent(projectId)}/preflight`,
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(preflight);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run Spur preflight";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
