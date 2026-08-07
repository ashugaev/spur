import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { ClaudeAccountSummary } from "@/lib/types";

export async function GET() {
  try {
    const result = await spurRequestJson<{ accounts: ClaudeAccountSummary[] }>("/claude-accounts");
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Claude accounts";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
