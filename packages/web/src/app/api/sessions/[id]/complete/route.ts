import { NextResponse, type NextRequest } from "next/server";
import { readRequestRecord, readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import { isOpenPrAction, type OpenPrAction } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface CompleteBody {
  prAction?: OpenPrAction;
}

async function readCompleteBody(request: NextRequest): Promise<CompleteBody> {
  const raw = await readRequestRecord(request);
  if (!raw) return {};
  const prAction = raw["prAction"];
  if (isOpenPrAction(prAction)) {
    return { prAction };
  }
  return {};
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = await readCompleteBody(request);
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/complete`,
      spurJsonInit("POST", body),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to complete Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
