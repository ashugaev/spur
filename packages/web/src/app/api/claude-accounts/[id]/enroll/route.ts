import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { ClaudeAccountSummary } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as { setupToken?: unknown };
    const setupToken = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
    if (!setupToken) {
      return NextResponse.json(
        { error: "setupToken must be a non-empty string" },
        { status: 400 },
      );
    }
    const result = await spurRequestJson<{ account: ClaudeAccountSummary }>(
      `/claude-accounts/${encodeURIComponent(id)}/enroll`,
      spurJsonInit("POST", { setupToken }),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enroll Claude account";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
