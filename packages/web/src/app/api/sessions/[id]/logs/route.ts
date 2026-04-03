import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const res = await spurRequest(`/sessions/${encodeURIComponent(id)}/logs`);
    if (!res.ok) {
      return new NextResponse(await res.text(), { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch session logs";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
