import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import type { TerminalLogin } from "@/lib/types";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: unknown;
    host?: unknown;
  };
  const target =
    typeof body.accountId === "string" && body.accountId
      ? { accountId: body.accountId }
      : typeof body.host === "string" && body.host
        ? { host: body.host }
        : null;
  if (!target) {
    return NextResponse.json({ error: "Supply accountId or host" }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await spurRequestJson<TerminalLogin>("/auth-terminal-logins", spurJsonInit("POST", target)),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to start terminal sign-in");
  }
}
