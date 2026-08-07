import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const result = await spurRequestJson<{ authenticated: boolean; loginActive: boolean }>(
      `/claude-accounts/${encodeURIComponent(id)}/login-status`,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read Claude account login status";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
