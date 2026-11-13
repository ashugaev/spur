import { NextResponse, type NextRequest } from "next/server";
import { resolvePageProxyTarget } from "@/lib/pages-proxy";
import { forwardToDaemon } from "@/lib/store-proxy-route";
import { augmentPageDocument } from "@/lib/page-document";
import { loadPageMetadata, pageManifest, renderPageIcon } from "@/lib/page-metadata";
import { spurErrorResponse } from "@/lib/spur-error-response";

interface RouteContext {
  params: Promise<{ id: string; path?: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { id, path = [] } = await context.params;
  // Relative asset URLs resolve against the page dir only with the trailing slash.
  if (path.length === 0 && !request.nextUrl.pathname.endsWith("/")) {
    // Path-only Location: request.url carries the custom server's localhost origin, not the public one.
    return new Response(null, {
      status: 308,
      headers: { Location: `${request.nextUrl.pathname}/${request.nextUrl.search}` },
    });
  }
  const target = resolvePageProxyTarget(id, path, request.method);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    if (target.kind === "manifest" || target.kind === "icon") {
      const page = await loadPageMetadata(id);
      if (target.kind === "icon") return await renderPageIcon(page, target.size);
      return new Response(JSON.stringify(pageManifest(page)), {
        headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" },
      });
    }
    const response = await forwardToDaemon(
      request,
      target.daemonPath,
      target.kind === "store" && target.forcePageSource
        ? {
            transformBody: (body) =>
              typeof body === "object" && body !== null && !Array.isArray(body)
                ? { ...body, source: { kind: "page" } }
                : body,
          }
        : {},
    );
    if (
      target.kind !== "file" ||
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("text/html")
    )
      return response;
    const html = augmentPageDocument(await response.text(), await loadPageMetadata(id));
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(html, { status: response.status, headers });
  } catch (error) {
    return spurErrorResponse(error, "Failed to serve page");
  }
}

export const dynamic = "force-dynamic";
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
