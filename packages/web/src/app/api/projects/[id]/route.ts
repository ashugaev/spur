import { NextResponse } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import type { DeleteProjectResponse, UpdateProjectResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function parsePayload(text: string, ok: boolean): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (ok) {
      throw new Error("Spur daemon returned invalid JSON");
    }
    return { error: text };
  }
}

function payloadError(payload: unknown, fallback: string): string {
  return typeof payload === "object" && payload !== null && "error" in payload
    ? String((payload as { error?: unknown }).error ?? fallback)
    : fallback;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const response = await spurRequest(
      `/projects/${encodeURIComponent(id)}`,
      spurJsonInit("PATCH", body),
    );
    const payload = parsePayload(await response.text(), response.ok);
    if (!response.ok) {
      return NextResponse.json(
        { error: payloadError(payload, `Failed to update Spur project (${response.status})`) },
        { status: response.status },
      );
    }
    return NextResponse.json(payload as UpdateProjectResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update Spur project";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(`/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const text = await response.text();
    const payload = parsePayload(text, response.ok);
    if (!response.ok) {
      const message = payloadError(payload, `Failed to delete Spur project (${response.status})`);
      return NextResponse.json({ error: message }, { status: response.status });
    }
    return NextResponse.json(payload as DeleteProjectResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete Spur project";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
