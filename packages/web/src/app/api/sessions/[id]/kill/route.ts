import { NextResponse, type NextRequest } from "next/server";
import { readRequestRecord, readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import { isOpenPrAction, type OpenPrAction } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface KillBody {
  force?: boolean;
  prAction?: OpenPrAction;
  skipPrCheck?: boolean;
}

async function readKillBody(request: NextRequest): Promise<KillBody> {
  const raw = await readRequestRecord(request);
  if (!raw) return {};
  const body: KillBody = {};
  if (raw["force"] === true) {
    body.force = true;
  }
  const prAction = raw["prAction"];
  if (isOpenPrAction(prAction)) {
    body.prAction = prAction;
  }
  if (raw["skipPrCheck"] === true) {
    body.skipPrCheck = true;
  }
  return body;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = await readKillBody(request);
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/kill`,
      spurJsonInit("POST", body),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to kill Spur session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
