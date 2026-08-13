import { NextResponse, type NextRequest } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface QueueActionBody {
  message?: string;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json()) as QueueActionBody;
    const message = body.message?.trim() ?? "";
    if (!message) {
      return NextResponse.json({ error: "message must be a non-empty string" }, { status: 400 });
    }
    // Forward the daemon status so 404 (not queued) / 409 (delivery in
    // flight) survive the hop, the same as the send route.
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/queue/remove`,
      spurJsonInit("POST", { message }),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to remove queued message";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
