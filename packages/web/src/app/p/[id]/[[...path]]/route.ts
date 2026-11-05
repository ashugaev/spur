import { NextResponse, type NextRequest } from "next/server";
import { resolvePageProxyTarget } from "@/lib/pages-proxy";
import { forwardToDaemon } from "@/lib/store-proxy-route";

interface RouteContext {
  params: Promise<{ id: string; path?: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { id, path = [] } = await context.params;
  // Relative asset URLs resolve against the page dir only with the trailing slash.
  if (path.length === 0 && !request.nextUrl.pathname.endsWith("/")) {
    // A plain URL: NextURL drops the trailing slash on serialization.
    const target = new URL(`${request.nextUrl.pathname}/${request.nextUrl.search}`, request.url);
    return NextResponse.redirect(target, 308);
  }
  const target = resolvePageProxyTarget(id, path, request.method);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return forwardToDaemon(
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
}

export const dynamic = "force-dynamic";
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
