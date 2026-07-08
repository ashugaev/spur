import { NextResponse } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string; name: string }>;
}

async function readRequestBody(request: Request): Promise<unknown | undefined> {
  const text = await request.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id, name } = await context.params;
  try {
    const body = await readRequestBody(request);
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/sidecars/${encodeURIComponent(name)}/start`,
      spurJsonInit("POST", body),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Spur sidecar";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
