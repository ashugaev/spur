import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import { randomUUID } from "node:crypto";
import { checkMutationGuard, forwardToDaemon } from "@/lib/store-proxy-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  let response: NextResponse;
  try {
    response = NextResponse.json(await spurRequestJson<unknown>("/pages"));
  } catch (error) {
    response = spurErrorResponse(error, "Failed to read pages");
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  const guard = checkMutationGuard(request);
  if (guard) return guard;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length
  ) {
    return NextResponse.json({ error: "Expected an empty object" }, { status: 400 });
  }
  const id = `p-${randomUUID()}`;
  return forwardToDaemon(
    new Request(request, {
      body: JSON.stringify({ id, title: "New page", template: "blank" }),
    }),
    "/pages",
  );
}
