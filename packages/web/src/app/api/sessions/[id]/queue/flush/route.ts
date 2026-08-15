import type { NextRequest } from "next/server";
import { proxyQueueAction } from "@/lib/queue-proxy";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return proxyQueueAction(request, id, "flush");
}
