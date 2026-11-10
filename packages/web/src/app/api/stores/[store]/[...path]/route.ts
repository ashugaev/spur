import { NextResponse, type NextRequest } from "next/server";
import { resolveStoreProxyTarget } from "@/lib/store-proxy";
import { forwardToDaemon } from "@/lib/store-proxy-route";

interface RouteContext {
  params: Promise<{ store: string; path: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { store, path } = await context.params;
  // Next hands over `%3A` undecoded in some versions; store ids never contain `%`.
  const storeId = store.replace(/%3A/gi, ":");
  const daemonPath = resolveStoreProxyTarget(storeId, path, request.method);
  if (!daemonPath) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return forwardToDaemon(request, daemonPath);
}

export const dynamic = "force-dynamic";
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
