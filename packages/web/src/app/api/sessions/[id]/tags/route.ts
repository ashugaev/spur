import { NextResponse } from "next/server";
import { spurRequest, spurJsonInit } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface TagsRequestBody {
  add?: string[];
  remove?: string[];
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  let body: TagsRequestBody;
  try {
    body = (await request.json()) as TagsRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const add = Array.isArray(body.add) ? body.add : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];
  if (add.length === 0 && remove.length === 0) {
    return NextResponse.json({ error: "No tag changes provided" }, { status: 400 });
  }

  try {
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/slots`,
      spurJsonInit("POST", {
        ...(add.length > 0 ? { tags: add } : {}),
        ...(remove.length > 0 ? { untags: remove } : {}),
      }),
    );
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error?: unknown }).error ?? "Failed to update tags")
          : `Failed to update tags (${response.status})`;
      return NextResponse.json({ error: message }, { status: response.status });
    }
    return NextResponse.json(payload as SpurSessionView);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update tags";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
