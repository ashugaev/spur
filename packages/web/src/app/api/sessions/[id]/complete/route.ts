import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import type { OpenPrAction } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface CompleteBody {
  prAction?: OpenPrAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readCompleteBody(request: NextRequest): Promise<CompleteBody> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {};
  }
  if (!isRecord(raw)) {
    return {};
  }
  const prAction = raw["prAction"];
  if (prAction === "leave_open" || prAction === "close") {
    return { prAction };
  }
  return {};
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = await readCompleteBody(request);
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/complete`,
      spurJsonInit("POST", body),
    );
    return NextResponse.json(await readPayload(response), { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to complete Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
