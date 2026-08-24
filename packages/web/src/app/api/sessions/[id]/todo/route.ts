import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";
import { isSpurTodoProjection } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(`/sessions/${encodeURIComponent(id)}/todo`);
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      return NextResponse.json(
        { error: "Invalid ToDo response from Spur daemon" },
        { status: 502 },
      );
    }
    if (response.ok && !isSpurTodoProjection(payload)) {
      return NextResponse.json(
        { error: "Invalid ToDo response from Spur daemon" },
        { status: 502 },
      );
    }
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read Spur ToDo" },
      { status: 502 },
    );
  }
}
