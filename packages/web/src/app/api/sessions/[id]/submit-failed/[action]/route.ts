import { NextResponse, type NextRequest } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string; action: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, action } = await context.params;
  if (action !== "retry" && action !== "dismiss") {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 404 });
  }
  try {
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/submit-failed/${action}`,
      spurJsonInit("POST", {}),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : `Failed to ${action} the prompt`;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
