import { describe, expect, it } from "vitest";
import { resolveSpawnModel } from "../../src/session-service.js";
import type { ProjectConfig } from "../../src/types.js";

function project(overrides: Partial<ProjectConfig>): ProjectConfig {
  return {
    path: "/repo",
    defaultBranch: "main",
    sessionPrefix: "backend",
    worktree: true,
    restoreAfterReboot: false,
    symlinks: [],
    sidecars: {},
    sources: {},
    backlog: {},
    triggers: {},
    ...overrides,
  };
}

describe("resolveSpawnModel", () => {
  it("returns the explicit request model regardless of agent", () => {
    const result = resolveSpawnModel({
      requestModel: "opus",
      resolvedAgent: "cursor",
      project: project({ defaultModels: { codex: "gpt-5.5" } }),
    });
    expect(result).toBe("opus");
  });

  it("applies the defaultModels entry for the resolved agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({ defaultModels: { codex: "gpt-5.5", cursor: "composer-2.5" } }),
    });
    expect(result).toBe("gpt-5.5");
  });

  it("does not bleed one agent's default model onto another agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "claude",
      project: project({ defaultModels: { codex: "gpt-5.5" } }),
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no default model is configured for the agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({ defaultModels: {} }),
    });
    expect(result).toBeUndefined();
  });

  it("applies the normal Cursor model when no Cursor default is configured", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "cursor",
      project: project({ defaultModels: {} }),
    });
    expect(result).toBe("composer-2.5");
  });
});
