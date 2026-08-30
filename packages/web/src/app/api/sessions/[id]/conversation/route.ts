import { NextResponse, type NextRequest } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const from = request.nextUrl.searchParams.get("from")?.trim();
  const query = from ? `?from=${encodeURIComponent(from)}` : "";
  try {
    const res = await spurRequest(`/sessions/${encodeURIComponent(id)}/conversation${query}`);
    if (!res.ok) {
      return new NextResponse(await res.text(), { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch conversation";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
