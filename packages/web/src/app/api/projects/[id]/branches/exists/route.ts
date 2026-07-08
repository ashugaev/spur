import { NextResponse, type NextRequest } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { BranchExistsResponse } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const name = request.nextUrl.searchParams.get("name")?.trim() ?? "";
  if (!name) {
    return NextResponse.json({
      exists: false,
      remote: false,
      checkedOutAt: null,
    } satisfies BranchExistsResponse);
  }
  try {
    const payload = await spurRequestJson<BranchExistsResponse>(
      `/projects/${encodeURIComponent(id)}/branches/exists?name=${encodeURIComponent(name)}`,
    );
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check branch status";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
