import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return NextResponse.json({ error: issueErr }, { status: 400 });
    }
  }

  const prompt =
    typeof body.prompt === "string" && body.prompt.trim().length > 0
      ? body.prompt.trim()
      : undefined;
  const agent =
    typeof body.agent === "string" && body.agent.trim().length > 0
      ? body.agent.trim()
      : undefined;
  const branch =
    typeof body.branch === "string" && body.branch.trim().length > 0
      ? body.branch.trim()
      : undefined;

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.spawn({
      projectId: body.projectId as string,
      issueId: (body.issueId as string) ?? undefined,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(branch !== undefined ? { branch } : {}),
    });

    return NextResponse.json({ session: sessionToDashboard(session) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
    );
  }
}
