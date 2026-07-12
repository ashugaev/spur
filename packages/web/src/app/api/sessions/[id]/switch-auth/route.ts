import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SwitchAuthBody {
  profile?: string;
  force?: boolean;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as SwitchAuthBody;
    const profile = typeof body.profile === "string" ? body.profile.trim() : "";
    if (!profile) {
      return NextResponse.json({ error: "profile must be a non-empty string" }, { status: 400 });
    }
    const payload: Record<string, unknown> = { profile };
    if (body.force === true) {
      payload.force = true;
    }
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/switch-auth`,
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to switch Spur session auth";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
