import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequest } from "@/lib/spur-daemon";
import type { CreateProjectResponse } from "@/lib/types";

interface ProjectsPostBody {
  displayName?: unknown;
  prefix?: unknown;
  path?: unknown;
}

export async function POST(request: NextRequest) {
  let body: ProjectsPostBody;
  try {
    body = (await request.json()) as ProjectsPostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";

  for (const [name, value] of [
    ["displayName", displayName],
    ["prefix", prefix],
    ["path", path],
  ] as const) {
    if (!value) {
      return NextResponse.json({ error: `${name} is required` }, { status: 400 });
    }
  }

  try {
    const response = await spurRequest(
      "/projects",
      spurJsonInit("POST", { displayName, prefix, path }),
    );
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};
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
