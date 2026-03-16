import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";

/** POST /api/sessions/:id/pipeline — Pipeline step actions (done, fail, goto) */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }

  try {
    const { pipelineEngine } = await getServices();
    if (!pipelineEngine) {
      return NextResponse.json({ error: "Pipeline engine not configured" }, { status: 404 });
    }

    const action = body.action;
    switch (action) {
      case "done": {
        const output = typeof body.output === "object" && body.output !== null
          ? body.output as Record<string, unknown>
          : undefined;
        pipelineEngine.done(id, output);
        break;
      }
      case "fail": {
        const reason = typeof body.reason === "string" ? body.reason : "manual fail";
        pipelineEngine.fail(id, reason);
        break;
      }
      case "goto": {
        if (typeof body.stepId !== "string") {
          return NextResponse.json({ error: "stepId is required for goto" }, { status: 400 });
        }
        pipelineEngine.goto(id, body.stepId);
        break;
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    const state = pipelineEngine.getState(id);
    return NextResponse.json({ ok: true, sessionId: id, state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pipeline action failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET /api/sessions/:id/pipeline — Get pipeline state */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { pipelineEngine } = await getServices();
    if (!pipelineEngine) {
      return NextResponse.json({ error: "Pipeline engine not configured" }, { status: 404 });
    }

    const state = pipelineEngine.getState(id) ?? pipelineEngine.load(id);
    if (!state) {
      return NextResponse.json({ error: "No pipeline state for session" }, { status: 404 });
    }

    return NextResponse.json({ sessionId: id, state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to get pipeline state";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
