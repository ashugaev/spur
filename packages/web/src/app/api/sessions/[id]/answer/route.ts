import { NextResponse, type NextRequest } from "next/server";
import { readResponsePayload } from "@/lib/json-payload";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface AnswerBody {
  optionIndex?: unknown;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const body = (await request.json()) as AnswerBody;
    const optionIndex = body.optionIndex;
    if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0) {
      return NextResponse.json(
        { error: "optionIndex must be a non-negative integer" },
        { status: 400 },
      );
    }
    const response = await spurRequest(
      `/sessions/${encodeURIComponent(id)}/answer`,
      spurJsonInit("POST", { optionIndex }),
    );
    return NextResponse.json(await readResponsePayload(response), { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to answer question";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
