import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const result = await spurRequestJson<{ loginTmuxSession: string }>(
      `/claude-accounts/${encodeURIComponent(id)}/start-login`,
      spurJsonInit("POST"),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start Claude account login";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
