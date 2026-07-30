import { NextResponse } from "next/server";
import { isSpurDaemonError, spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { ClaudeAccountSummary } from "@/lib/types";

interface AddAccountBody {
  label?: string;
  setupToken?: string;
}

interface AddAccountResult {
  account: ClaudeAccountSummary;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as AddAccountBody;
    const payload: Record<string, unknown> = {};
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const setupToken = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
    if (!setupToken) {
      return NextResponse.json({ error: "setupToken must be a non-empty string" }, { status: 400 });
    }
    if (label) payload.label = label;
    payload.setupToken = setupToken;
    const result = await spurRequestJson<AddAccountResult>(
      "/claude-accounts/add",
      spurJsonInit("POST", payload),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add Claude account";
    return NextResponse.json(
      { error: message },
      { status: isSpurDaemonError(error) ? error.status : 502 },
    );
  }
}
