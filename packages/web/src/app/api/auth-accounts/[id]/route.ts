import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const result = await spurRequestJson<{ removed: string }>(
      `/auth-accounts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return NextResponse.json(result);
  } catch (error) {
    return spurErrorResponse(error, "Failed to remove authorization account");
  }
}
