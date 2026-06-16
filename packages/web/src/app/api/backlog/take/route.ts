import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { TakeBacklogItemResponse } from "@/lib/types";

interface TakeBacklogBody {
  projectId?: string;
  sourceId?: string;
  externalId?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TakeBacklogBody;
    const projectId = body.projectId?.trim();
    const sourceId = body.sourceId?.trim();
    const externalId = body.externalId?.trim();

    if (!projectId || !sourceId || !externalId) {
      return NextResponse.json(
        { error: "projectId, sourceId, and externalId are required" },
        { status: 400 },
      );
    }

    const result = await spurRequestJson<TakeBacklogItemResponse>(
      "/backlog/take",
      spurJsonInit("POST", { projectId, sourceId, externalId }),
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to take backlog item";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
