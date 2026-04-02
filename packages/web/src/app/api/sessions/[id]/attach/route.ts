import { NextResponse } from "next/server";
import { openTmuxTerminal } from "@/lib/open-tmux-terminal";
import { spurRequestJson } from "@/lib/spur-daemon";
import type { SpurSessionView } from "@/lib/types";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_: Request, context: RouteContext) {
  const { id } = await context.params;

  let session: SpurSessionView;
  try {
    session = await spurRequestJson<SpurSessionView>(`/sessions/${encodeURIComponent(id)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!session.runtimeAlive || !session.tmuxSession || !session.worktreePath) {
    return NextResponse.json({ error: "session terminal is not available" }, { status: 409 });
  }

  try {
    await openTmuxTerminal({
      tmuxSession: session.tmuxSession,
      worktreePath: session.worktreePath,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open session terminal";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
