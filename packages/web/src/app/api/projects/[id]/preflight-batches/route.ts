import { NextResponse } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(
      await spurRequestJson<{ preflightBatchId: string }>(
        `/projects/${encodeURIComponent(id)}/preflight-batches`,
        spurJsonInit("POST"),
      ),
    );
  } catch (error) {
    return spurErrorResponse(error, "Failed to allocate pre-flight usage batch");
  }
}
