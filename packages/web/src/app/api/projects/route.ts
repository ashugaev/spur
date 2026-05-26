import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import type { CreateProjectResponse } from "@/lib/types";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const response = await spurRequest("/projects", spurJsonInit("POST", body));
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text };
      }
    }
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error?: unknown }).error ?? "Failed to create Spur project")
          : `Failed to create Spur project (${response.status})`;
      return NextResponse.json({ error: message }, { status: response.status });
    }
    return NextResponse.json(payload as CreateProjectResponse, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create Spur project";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
