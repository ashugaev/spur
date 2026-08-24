import { describe, expect, it } from "vitest";
import {
  buildDeskSpawnPayload,
  buildRespawnSessionPayload,
  buildSpawnSessionPayload,
  type SpawnPayloadFields,
} from "@/lib/spawn-payload";

function composer(overrides: Partial<SpawnPayloadFields>): SpawnPayloadFields {
  return {
    agent: "claude",
    attachments: [],
    branch: "",
    defaultBranch: "",
    model: null,
    mode: null,
    planMode: false,
    projectId: "api",
    prompt: "  Fix auth  ",
    selfDestruct: false,
    selfDestructConditions: "",
    startupAttachmentIds: [],
    steps: [],
    trackerUrl: null,
    workspaceMode: "worktree",
    ...overrides,
  };
}

describe("spawn composer payload builders", () => {
  it("builds spawn payload with only enabled optional fields", () => {
    expect(
      buildSpawnSessionPayload(
        composer({
          branch: "!!!",
          model: null,
          steps: [{ id: 1, value: " " }],
        }),
      ),
    ).toEqual({
      projectId: "api",
      prompt: "Fix auth",
      agent: "claude",
      overrides: { worktree: true },
    });
  });

  it("builds full spawn payload with normalized branch and overrides", () => {
    expect(
      buildSpawnSessionPayload(
        composer({
          attachments: [
            { file: new File(["x"], "bad name.png"), preview: "data:image/png;base64,abc" },
          ],
          branch: "Feature: Auth!",
          defaultBranch: " main ",
          model: "opus",
          mode: "manager",
          planMode: true,
          selfDestruct: true,
          selfDestructConditions: " after tests ",
          steps: [
            { id: 1, value: " research " },
            { id: 2, value: "" },
          ],
          trackerUrl: "https://example.com/issues/42",
          workspaceMode: "worktree",
        }),
      ),
    ).toEqual({
      projectId: "api",
      prompt: "Fix auth",
      agent: "claude",
      model: "opus",
      mode: "manager",
      attachments: [{ name: "bad_name.png", data: "abc" }],
      branch: "feature-auth",
      planMode: true,
      selfDestruct: { enabled: true, conditions: "after tests" },
      steps: ["research"],
      slots: { links: [{ label: "tracker", url: "https://example.com/issues/42" }] },
      overrides: { worktree: true, defaultBranch: "main" },
    });
  });

  it("builds respawn payload without agent unless changed", () => {
    expect(
      buildRespawnSessionPayload(
        {
          agent: "codex",
          attachments: [],
          model: "gpt-5.5",
          prompt: "  Fix auth  ",
          startupAttachmentIds: ["img-1"],
        },
        "claude",
        true,
      ),
    ).toEqual({
      prompt: "Fix auth",
      startupAttachmentIds: ["img-1"],
      forceKillSource: true,
      agent: "codex",
      model: "gpt-5.5",
    });
  });

  it("builds desk payload with fixed session context and selected model", () => {
    expect(
      buildDeskSpawnPayload(
        {
          agent: "cursor",
          attachments: [],
          branch: "helper/auth",
          model: "auto",
          planMode: true,
          prompt: "  Fix auth  ",
          steps: [{ id: 1, value: " test " }],
        },
        { id: "api-a1", projectId: "api", worktree: true },
      ),
    ).toEqual({
      projectId: "api",
      prompt: "Fix auth",
      agent: "cursor",
      model: "auto",
      reuseWorkspaceSessionId: "api-a1",
      overrides: { worktree: true },
      branch: "helper/auth",
      planMode: true,
      steps: ["test"],
    });
  });
});
