import { describe, expect, it } from "vitest";
import { getDisplayTaskLine, parseSessionPromptView } from "@/lib/session-prompt";
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

describe("parseSessionPromptView", () => {
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

  it("flags shepherd mode without dumping rules into the task panel", () => {
    const view = parseSessionPromptView(
      makeSession({
        projectId: "spur-shepherd",
        originalTaskPrompt: "ping",
        prompt: "You are Spur Shepherd: an orchestration agent for Spur.\n\nOperator request:\nping",
      }),
    );

    expect(view.task).toBe("ping");
    expect(view.shepherdMode).toBe(true);
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
});
