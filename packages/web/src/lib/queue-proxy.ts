import { NextResponse, type NextRequest } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

// Both queue routes (remove, flush) are the same content-keyed proxy: the
// row's exact message text in, the daemon's status forwarded verbatim out so
// 404 (not queued) / 409 (delivery in flight) survive the hop, the same as the
// send route.
export async function proxyQueueAction(
  request: NextRequest,
  sessionId: string,
  action: "remove" | "flush",
) {
  try {
    const body = (await request.json()) as { message?: string };
    const message = body.message?.trim() ?? "";
    if (!message) {
      return NextResponse.json({ error: "message must be a non-empty string" }, { status: 400 });
    }
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(sessionId)}/queue/${action}`,
      spurJsonInit("POST", { message }),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : `Failed to ${action} queued message`;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
