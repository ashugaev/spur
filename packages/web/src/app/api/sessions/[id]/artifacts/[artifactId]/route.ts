import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string; artifactId: string }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id, artifactId } = await context.params;
  try {
    const res = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
    if (!res.ok) {
      return new NextResponse(await res.text(), { status: res.status });
    }
    return new NextResponse(res.body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition": res.headers.get("content-disposition") ?? "attachment",
        "cache-control": "no-store",
        // Keeps the daemon's sandbox on HTML artifacts: they render in an opaque
        // origin, so agent-authored markup cannot reach the dashboard origin.
        ...(res.headers.get("content-security-policy")
          ? { "content-security-policy": res.headers.get("content-security-policy") ?? "" }
          : {}),
        ...(res.headers.get("content-length")
          ? { "content-length": res.headers.get("content-length") ?? "" }
          : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch artifact";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
