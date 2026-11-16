import { NextResponse } from "next/server";
import { readOptionalRequestRecord } from "@/lib/json-payload";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthLogin } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  let body: Record<string, unknown> | undefined;
  try {
    body = await readOptionalRequestRecord(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
  try {
    const result = await spurRequestJson<AuthLogin>(
      `/auth-accounts/${encodeURIComponent(id)}/login`,
      spurJsonInit("POST", typeof body?.method === "string" ? { method: body.method } : undefined),
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to start sign-in");
  }
}
