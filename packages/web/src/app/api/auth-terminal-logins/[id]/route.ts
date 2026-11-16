import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { TerminalLogin } from "@/lib/types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    return NextResponse.json(
      await spurRequestJson<TerminalLogin>(`/auth-terminal-logins/${encodeURIComponent(id)}`),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to read terminal sign-in");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    return NextResponse.json(
      await spurRequestJson<{ stopped: string }>(`/auth-terminal-logins/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to stop terminal sign-in");
  }
}
