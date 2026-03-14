import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/** POST /api/sessions/:id/restart — Kill session, reset to default branch, re-spawn */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const agentOverride = typeof body?.agent === "string" ? body.agent : undefined;

  try {
    const { sessionManager } = await getServices();

    const session = await sessionManager.get(id);
    if (!session) {
      return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
    }

    const { projectId, issueId, metadata } = session;
    const prompt = metadata["prompt"] || undefined;

    await sessionManager.kill(id);

    const newSession = await sessionManager.spawn({
      projectId,
      issueId: issueId ?? undefined,
      prompt,
      agent: agentOverride,
    });

    return NextResponse.json({ session: sessionToDashboard(newSession) }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to restart session";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
