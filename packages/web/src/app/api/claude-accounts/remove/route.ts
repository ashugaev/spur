import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";

interface RemoveAccountBody {
  id?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as RemoveAccountBody;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return NextResponse.json({ error: "id must be a non-empty string" }, { status: 400 });
    }
    const result = await spurRequestJson<{ removed: string }>(
      "/claude-accounts/remove",
      spurJsonInit("POST", { id }),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove Claude account";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
