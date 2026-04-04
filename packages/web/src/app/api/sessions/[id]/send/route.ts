import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SendBody {
  message?: string;
  attachments?: Array<{ name: string; data: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json()) as SendBody;
    const message = body.message?.trim() ?? "";
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!message && !hasAttachments) {
      return NextResponse.json({ error: "message or attachments required" }, { status: 400 });
    }
    const result = await spurRequestJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(id)}/send`,
      spurJsonInit("POST", { message, attachments: body.attachments }),
    );
    return NextResponse.json(result);
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Failed to send message to Spur session";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
