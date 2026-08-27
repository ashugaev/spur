import { NextResponse } from "next/server";
import { ARTIFACT_HTML_CSP, isHtmlMimeType } from "@/lib/artifact-html";
import { spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string; artifactId: string[] }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id, artifactId } = await context.params;
  try {
    const artifactPath = artifactId.map((segment) => encodeURIComponent(segment)).join("/");
    const res = await spurRequest(`/sessions/${encodeURIComponent(id)}/artifacts/${artifactPath}`);
    if (!res.ok) {
      return new NextResponse(await res.text(), { status: res.status });
    }
    const contentType = res.headers.get("content-type");
    return new NextResponse(res.body, {
      status: res.status,
      headers: {
        "content-type": contentType ?? "application/octet-stream",
        "content-disposition": res.headers.get("content-disposition") ?? "attachment",
        "cache-control": "no-store",
        // Artifact HTML always leaves this route sandboxed, whatever the daemon sent:
        // an older or remote daemon that omits the header must not put agent-authored
        // markup on the dashboard origin.
        ...(isHtmlMimeType(contentType)
          ? {
              "content-security-policy":
                res.headers.get("content-security-policy") ?? ARTIFACT_HTML_CSP,
            }
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
