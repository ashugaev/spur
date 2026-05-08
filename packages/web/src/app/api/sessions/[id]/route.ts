import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(`/sessions/${encodeURIComponent(id)}`);
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};

    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error?: unknown }).error ?? "Failed to read Spur session")
          : `Failed to read Spur session (${response.status})`;
      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(payload as SpurSessionView);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
