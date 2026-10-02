import { NextResponse } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const text = await request.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) {
      return NextResponse.json({ error: "Expected an object body" }, { status: 400 });
    }
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/restore`,
      spurJsonInit("POST", body),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restore Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
