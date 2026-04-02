import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface SpawnBody {
  projectId?: string;
  prompt?: string;
  agent?: "claude" | "codex";
  branch?: string;
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

    const session = await spurRequestJson<SpurSessionView>(
      "/sessions",
      spurJsonInit("POST", {
        project,
        prompt,
        ...(body.agent ? { agent: body.agent } : {}),
        ...(body.branch?.trim() ? { branch: body.branch.trim() } : {}),
      }),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
