import { NextResponse, type NextRequest } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const WAKE_TARGETS = new Set(["scheduled", "interval", "daily"]);
const SCHEDULE_FIELDS = ["at", "delayMs", "intervalMs", "dailyAt", "stopCondition"] as const;

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const target = body.target;
    if (target === undefined) {
      return NextResponse.json({ error: "target is required" }, { status: 400 });
    }
    if (typeof target !== "string" || !WAKE_TARGETS.has(target)) {
      return NextResponse.json(
        { error: "target must be scheduled, interval, or daily" },
        { status: 400 },
      );
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json({ error: "message must be a non-empty string" }, { status: 400 });
    }
    for (const field of SCHEDULE_FIELDS) {
      if (body[field] !== undefined) {
        return NextResponse.json(
          { error: `${field} cannot be combined with target` },
          { status: 400 },
        );
      }
    }
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/wake`,
      spurJsonInit("POST", { target, message }),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to update wake message";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
