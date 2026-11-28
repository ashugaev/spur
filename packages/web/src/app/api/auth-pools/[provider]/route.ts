import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthPool } from "@/lib/types";

interface RouteContext {
  params: Promise<{ provider: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { provider } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    defaultAccountId?: unknown;
    autoRotate?: unknown;
    applyToActive?: unknown;
  };
  const update: { defaultAccountId?: unknown; autoRotate?: unknown; applyToActive?: unknown } = {};
  if (body.defaultAccountId !== undefined) update.defaultAccountId = body.defaultAccountId;
  if (body.autoRotate !== undefined) update.autoRotate = body.autoRotate;
  if (body.applyToActive !== undefined) update.applyToActive = body.applyToActive;
  try {
    const result = await spurRequestJson<{ pool: AuthPool; moved: number }>(
      `/auth-pools/${encodeURIComponent(provider)}`,
      spurJsonInit("PATCH", update),
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to update authorization pool");
  }
}
