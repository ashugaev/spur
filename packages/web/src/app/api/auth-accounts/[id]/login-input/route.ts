import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthLogin } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { input?: unknown; cancel?: unknown };
  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (body.cancel !== true && !input) {
    return NextResponse.json({ error: "Supply input or cancel:true" }, { status: 400 });
  }
  try {
    const result = await spurRequestJson<AuthLogin>(
      `/auth-accounts/${encodeURIComponent(id)}/login-input`,
      spurJsonInit("POST", body.cancel === true ? { cancel: true } : { input }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to submit sign-in input");
  }
}
