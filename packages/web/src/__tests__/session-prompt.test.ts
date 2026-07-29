import { describe, expect, it } from "vitest";
import { getDisplayTaskLine, parseSessionPromptView } from "@/lib/session-prompt";
import { DEFAULT_SELF_DESTRUCT_CONDITION } from "@/lib/self-destruct";
import type { DashboardSession } from "@/lib/types";

function makeSession(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "sess-1",
    projectId: "api",
    projectName: "api",
    agent: "claude",
    title: null,
    prompt: "",
    originalTaskPrompt: null,
    startupAttachmentIds: [],
    branch: null,
    worktree: false,
    tmuxSession: null,
    status: "running",
    state: "working",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
    lastActivityAt: "2026-03-18T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/worktrees/api/sess-1",
    services: [],
    artifacts: [],
    queuedMessages: { messages: [], awaitingPrompt: false },
    sidecars: [],
    runningSidecars: [],
    links: [],
    tags: [],
    hasServiceIssues: false,
    deskKey: "sess-1",
    ...overrides,
  };
}

const SHEPHERD_PROMPT = `You are Spur Shepherd: an orchestration agent for Spur.

Rules:
- Delegate repo work to worker agents.

Initial action:
1. Run spur list.

Operator request:
ping`;

describe("parseSessionPromptView", () => {
  it("shows only the operator request for shepherd sessions", () => {
    const view = parseSessionPromptView(
      makeSession({
        projectId: "spur-shepherd",
        prompt: SHEPHERD_PROMPT,
      }),
    );

    expect(view.task).toBe("ping");
    expect(view.handoff).toBeNull();
  });

  it("shows the stored original task instead of handoff boilerplate", () => {
    const view = parseSessionPromptView(
      makeSession({
        originalTaskPrompt: "ping",
        prompt:
          "Task handoff from session shp-872c (claude).\n\nOriginal task (as originally requested):\nping\n\nAdditional handoff notes:\ntst",
      }),
    );

    expect(view.task).toBe("ping");
    expect(view.handoff).toEqual({
      sourceSessionId: "shp-872c",
      sourceAgent: "claude",
      notes: "tst",
    });
  });

  it("surfaces self-destruct conditions from session metadata", () => {
    const view = parseSessionPromptView(
      makeSession({
        originalTaskPrompt: "ship it",
        selfDestruct: { enabled: true, conditions: "the summary is posted" },
      }),
    );

    expect(view.selfDestructLabel).toBe("the summary is posted");
  });

  it("falls back to the default self-destruct condition when none is set", () => {
    const view = parseSessionPromptView(
      makeSession({
        originalTaskPrompt: "ship it",
        selfDestruct: { enabled: true },
      }),
    );

    expect(view.selfDestructLabel).toBe(DEFAULT_SELF_DESTRUCT_CONDITION);
  });
});

describe("getDisplayTaskLine", () => {
  it("prefers the stored original task", () => {
    expect(
      getDisplayTaskLine(
        makeSession({
          originalTaskPrompt: "ping",
          prompt: "Task handoff from session shp-1 (cursor).",
        }),
      ),
    ).toBe("ping");
  });

  it("extracts operator request from wrapped shepherd prompts", () => {
    expect(
      getDisplayTaskLine(
        makeSession({
          projectId: "spur-shepherd",
          prompt: SHEPHERD_PROMPT,
        }),
      ),
    ).toBe("ping");
  });
});
