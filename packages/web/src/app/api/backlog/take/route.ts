import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import type { TakeBacklogItemResponse } from "@/lib/types";

interface TakeBacklogBody {
  projectId?: string;
  backlogId?: string;
  externalId?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TakeBacklogBody;
    const projectId = body.projectId?.trim();
    const backlogId = body.backlogId?.trim();
    const externalId = body.externalId?.trim();

    if (!projectId || !backlogId || !externalId) {
      return NextResponse.json(
        { error: "projectId, backlogId, and externalId are required" },
        { status: 400 },
      );
    }

    const response = await spurRequest(
      "/backlog/take",
      spurJsonInit("POST", { projectId, backlogId, externalId }),
    );
    const text = await response.text();

    if (!response.ok) {
      const contentType = response.headers.get("content-type");
      return new Response(text, {
        status: response.status,
        headers: contentType ? { "content-type": contentType } : undefined,
      });
    }

    let result: unknown;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Spur daemon response was not valid JSON");
    }

    return NextResponse.json(result as TakeBacklogItemResponse, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to take backlog item";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
