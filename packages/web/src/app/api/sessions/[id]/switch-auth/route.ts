import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SwitchAuthBody {
  accountId?: string | null;
  force?: boolean;
}

/** `accountId: null` returns the session to Auto. */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as SwitchAuthBody;
    const accountId =
      body.accountId === null
        ? null
        : typeof body.accountId === "string"
          ? body.accountId.trim()
          : "";
    if (accountId === "") {
      return NextResponse.json(
        { error: "accountId must be a non-empty string or null" },
        { status: 400 },
      );
    }
    const payload: Record<string, unknown> = { accountId };
    if (body.force === true) {
      payload.force = true;
    }
    const result = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(id)}/switch-auth`,
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to switch Spur session auth");
  }
}
