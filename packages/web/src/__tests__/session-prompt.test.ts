import { describe, expect, it } from "vitest";
import { getDisplayTaskLine, parseSessionPromptView } from "@/lib/session-prompt";
import { DEFAULT_SELF_DESTRUCT_CONDITION } from "@/lib/self-destruct";
import type { DashboardSession } from "@/lib/types";
import { renderBootstrapPrompt } from "../../../../v2/src/bootstrap-prompt.js";

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
const TELEGRAM_REPLY_SUFFIX = `

Source: telegram. The requester only sees messages you send with:
spur source reply "<message>"
Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.`;
const BOOTSTRAP_PROMPT = `You are configuring a new Spur project named "Demo App".

Inputs (do not change these values):
- project id: demo-app
- sessionPrefix: demo
- project path: /repo/demo

Goal: write a spur.yaml at the project root that registers this project, then ask Spur to connect it.

Steps:
1. Inspect the project.

Constraints:
- Do not modify any file other than spur.yaml.
- Do not run package managers, build tools, or tests.
- Do not create branches, commits, or pushes.
- Keep total output under 40 lines.`;

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

  it("removes the exact trailing Telegram reply suffix from stored provenance", () => {
    const view = parseSessionPromptView(
      makeSession({
        originalTaskPrompt: `Fix payment retries${TELEGRAM_REPLY_SUFFIX}`,
        prompt: "runtime prompt",
      }),
    );

    expect(view.task).toBe("Fix payment retries");
  });

  it("removes the exact trailing Telegram reply suffix from the raw prompt fallback", () => {
    const view = parseSessionPromptView(
      makeSession({
        prompt: `Fix payment retries${TELEGRAM_REPLY_SUFFIX}`,
      }),
    );

    expect(view.task).toBe("Fix payment retries");
  });

  it("preserves Telegram reply text when it is not the trailing wrapper", () => {
    const prompt = `Keep this exact example:${TELEGRAM_REPLY_SUFFIX}

Then update the docs.`;

    expect(parseSessionPromptView(makeSession({ prompt })).task).toBe(prompt);
  });

  it("keeps generated bootstrap configuration prompts available for display", () => {
    expect(
      parseSessionPromptView(
        makeSession({
          originalTaskPrompt: BOOTSTRAP_PROMPT,
          prompt: BOOTSTRAP_PROMPT,
        }),
      ).task,
    ).toBe(BOOTSTRAP_PROMPT);
  });

  it("keeps generated bootstrap prompts whose display name contains quotes available for display", () => {
    const prompt = renderBootstrapPrompt({
      id: "api",
      displayName: 'Bob’s "API"',
      prefix: "api",
      path: "/repo/api",
      port: 3000,
    });

    expect(parseSessionPromptView(makeSession({ prompt })).task).toBe(prompt.trim());
  });

  it("preserves user tasks that only resemble bootstrap prose", () => {
    const prompt = 'You are configuring a new Spur project named "Demo App".';

    expect(parseSessionPromptView(makeSession({ prompt })).task).toBe(prompt);
  });

  it("preserves text appended after a bootstrap-shaped task", () => {
    const prompt = `${BOOTSTRAP_PROMPT}
Then audit the deployment.`;

    expect(parseSessionPromptView(makeSession({ prompt })).task).toBe(prompt);
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
