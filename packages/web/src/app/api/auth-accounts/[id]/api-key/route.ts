import { NextResponse } from "next/server";
import { readRequestRecord } from "@/lib/json-payload";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthLogin } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await readRequestRecord(request);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!body || !label || typeof body.apiKey !== "string" || !body.apiKey) {
    return NextResponse.json({ error: "Supply a label and an apiKey" }, { status: 400 });
  }
  try {
    const result = await spurRequestJson<AuthLogin>(
      `/auth-accounts/${encodeURIComponent(id)}/api-key`,
      spurJsonInit("POST", { label, apiKey: body.apiKey }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to save API key");
  }
}
