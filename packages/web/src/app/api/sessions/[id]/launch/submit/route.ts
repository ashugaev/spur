import { NextResponse, type NextRequest } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/launch/submit`,
      spurJsonInit("POST", {}),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to submit the prompt";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
