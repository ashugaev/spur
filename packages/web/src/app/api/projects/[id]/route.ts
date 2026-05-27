import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";
import type { DeleteProjectResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(`/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error?: unknown }).error ?? "Failed to delete Spur project")
          : `Failed to delete Spur project (${response.status})`;
      return NextResponse.json({ error: message }, { status: response.status });
    }
    return NextResponse.json(payload as DeleteProjectResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete Spur project";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
