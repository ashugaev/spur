import { NextResponse } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/reopen`,
      spurJsonInit("POST"),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reopen Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
