import { type NextRequest, NextResponse } from "next/server";
import { ghHeaders } from "@/lib/github-api";
import { extractPrCoords, markPrStatusMerged } from "@/lib/pr-status-store";

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof payload?.url === "string" ? payload.url : "";
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const coords = extractPrCoords(url);
  if (!coords) {
    return NextResponse.json({ error: "invalid GitHub PR URL" }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${coords.owner}/${coords.repo}/pulls/${coords.number}/merge`,
      {
        method: "PUT",
        headers: {
          ...ghHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ merge_method: "squash" }),
        cache: "no-store",
      },
    );

    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      sha?: unknown;
    } | null;
    if (!response.ok) {
      const message =
        typeof body?.message === "string" && body.message.trim().length > 0
          ? body.message
          : `GitHub API ${response.status}`;
      return NextResponse.json({ error: message }, { status: response.status });
    }

    markPrStatusMerged(url);
    return NextResponse.json({
      ok: true,
      merged: true,
      sha: typeof body?.sha === "string" ? body.sha : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "GitHub merge failed" },
      { status: 500 },
    );
  }
}
