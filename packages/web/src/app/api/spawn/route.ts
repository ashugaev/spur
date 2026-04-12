import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import type { SpawnOverrides, SpurSpawnResult } from "@/lib/types";

interface SpawnBody {
  projectId?: string;
  prompt?: string;
  agent?: "claude" | "codex";
  members?: Array<{ agent?: "claude" | "codex"; name?: string }>;
  branch?: string;
  planMode?: boolean;
  steps?: string[];
  overrides?: SpawnOverrides;
}

class SpawnRequestError extends Error {}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SpawnBody;
    const project = body.projectId?.trim();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!project) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const filteredSteps = Array.isArray(body.steps)
      ? body.steps
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
      : undefined;
    const filteredMembers = Array.isArray(body.members)
      ? body.members.map((member, index) => {
          if (
            !member ||
            typeof member.agent !== "string" ||
            (member.agent !== "claude" && member.agent !== "codex")
          ) {
            throw new SpawnRequestError(`members[${index}].agent must be claude or codex`);
          }
          if (
            member.name !== undefined &&
            (typeof member.name !== "string" || !member.name.trim())
          ) {
            throw new SpawnRequestError(
              `members[${index}].name must be a non-empty string when provided`,
            );
          }
          return {
            agent: member.agent,
            ...(member.name?.trim() ? { name: member.name.trim() } : {}),
          };
        })
      : undefined;
    if (body.agent && filteredMembers?.length) {
      return NextResponse.json({ error: "agent cannot be combined with members" }, { status: 400 });
    }
    if (
      !body.agent &&
      body.members !== undefined &&
      (!filteredMembers || filteredMembers.length === 0)
    ) {
      return NextResponse.json(
        { error: "members must contain at least one entry" },
        { status: 400 },
      );
    }

    const overrides =
      body.overrides && Object.keys(body.overrides).length > 0 ? body.overrides : undefined;

    const payload: Record<string, unknown> = { project, prompt };
    if (filteredMembers?.length) payload.members = filteredMembers;
    else if (body.agent) payload.agent = body.agent;
    if (body.branch?.trim()) payload.branch = body.branch.trim();
    if (body.planMode === true) payload.planMode = true;
    if (filteredSteps && filteredSteps.length > 0) payload.steps = filteredSteps;
    if (overrides) payload.overrides = overrides;

    const session = await spurRequestJson<SpurSpawnResult>(
      "/sessions",
      spurJsonInit("POST", payload),
    );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn Spur session";
    const status = error instanceof SpawnRequestError ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
