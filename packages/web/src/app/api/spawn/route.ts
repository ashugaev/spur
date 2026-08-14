import { NextResponse, type NextRequest } from "next/server";
import { spurJsonInit, spurRequestJson } from "@/lib/spur-daemon";
import { spurErrorResponse } from "@/lib/spur-error-response";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import type { SpawnOverrides, SpurSessionView, SpurSpawnResult } from "@/lib/types";

interface SpawnBody {
  projectId?: string;
  prompt?: string;
  agent?: AgentName;
  members?: Array<{ agent?: AgentName; name?: string }>;
  model?: string;
  mode?: string;
  attachments?: Array<{ name: string; data: string }>;
  branch?: string;
  planMode?: boolean;
  steps?: string[];
  overrides?: SpawnOverrides;
  selfDestruct?: { enabled: boolean; conditions?: string };
  reuseWorkspaceSessionId?: string;
  bootstrap?: boolean;
  slots?: { links?: Array<{ label: string; url: string }> };
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
            !AGENT_OPTIONS.includes(member.agent as AgentName)
          ) {
            throw new SpawnRequestError(
              `members[${index}].agent must be one of ${AGENT_OPTIONS.join(", ")}`,
            );
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
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      payload.attachments = body.attachments;
    }
    if (filteredMembers?.length) {
      payload.members = filteredMembers;
    } else {
      if (body.agent) payload.agent = body.agent;
      if (body.model?.trim()) payload.model = body.model.trim();
    }
    if (body.mode?.trim()) payload.mode = body.mode.trim();
    if (body.branch?.trim()) payload.branch = body.branch.trim();
    if (body.planMode === true) payload.planMode = true;
    if (body.selfDestruct) payload.selfDestruct = body.selfDestruct;
    if (filteredSteps && filteredSteps.length > 0) payload.steps = filteredSteps;
    if (overrides) payload.overrides = overrides;
    const reuseId = body.reuseWorkspaceSessionId?.trim();
    if (reuseId) payload.reuseWorkspaceSessionId = reuseId;
    if (body.bootstrap === true) payload.bootstrap = true;
    if (Array.isArray(body.slots?.links) && body.slots.links.length > 0) {
      payload.slots = { links: body.slots.links };
    }

    const session = filteredMembers?.length
      ? await spurRequestJson<SpurSpawnResult>("/sessions", spurJsonInit("POST", payload))
      : await spurRequestJson<SpurSessionView>(
          "/sessions/background",
          spurJsonInit("POST", payload),
        );

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    if (error instanceof SpawnRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return spurErrorResponse(error, "Failed to spawn Spur session");
  }
}
