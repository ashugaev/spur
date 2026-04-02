import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SendBody {
  message?: string;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json()) as SendBody;
    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const result = await spurRequestJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(id)}/send`,
      spurJsonInit("POST", { message }),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send message to Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
