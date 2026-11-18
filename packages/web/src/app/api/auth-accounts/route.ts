import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { AuthAccountSummary, AuthAccountsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await spurRequestJson<AuthAccountsResponse>("/auth-accounts"));
  } catch (error) {
    return spurErrorResponse(error, "Failed to list authorization accounts");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { provider?: unknown };
    const result = await spurRequestJson<{ account: AuthAccountSummary }>(
      "/auth-accounts",
      spurJsonInit("POST", { provider: body.provider }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return spurErrorResponse(error, "Failed to add authorization account");
  }
}
