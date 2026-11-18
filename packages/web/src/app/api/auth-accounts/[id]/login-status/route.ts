import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthLogin } from "@/lib/types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const result = await spurRequestJson<AuthLogin>(
      `/auth-accounts/${encodeURIComponent(id)}/login-status`,
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to read sign-in status");
  }
}
