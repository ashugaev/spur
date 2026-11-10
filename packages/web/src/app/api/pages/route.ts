import { NextResponse } from "next/server";
import { spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";

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
