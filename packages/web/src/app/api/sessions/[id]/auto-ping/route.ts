import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";
import { isAutoPingMuteProjection } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/auto-ping-suppressions?all=1`,
    );
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      return NextResponse.json(
        { error: "Invalid auto-ping response from Spur daemon" },
        { status: 502 },
      );
    }
    if (response.ok && !isAutoPingMuteProjection(payload)) {
      return NextResponse.json(
        { error: "Invalid auto-ping response from Spur daemon" },
        { status: 502 },
      );
    }
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read auto-ping mutes" },
      { status: 502 },
    );
  }
}
