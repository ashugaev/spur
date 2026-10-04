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
  it.each(["claude", "cursor"] as const)(
    "returns the explicit request model for %s",
    (resolvedAgent) => {
      const result = resolveSpawnModel({
        requestModel: "opus",
        resolvedAgent,
        project: project({ defaultModels: { claude: "sonnet", codex: "gpt-5.5" } }),
      });
      expect(result).toBe("opus");
    },
  );

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
      resolvedAgent: "codex",
      project: project({ defaultModels: { cursor: "composer-2.5" } }),
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

  it("applies sonnet as the Claude default when none is configured", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "claude",
      project: project({ defaultModels: {} }),
    });
    expect(result).toBe("sonnet");
  });

  it("lets a configured Claude opus default override Spur's sonnet default", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "claude",
      project: project({ defaultModels: { claude: "opus" } }),
    });
    expect(result).toBe("opus");
  });

  it("applies auto as the Cursor default when no Cursor default is configured", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "cursor",
      project: project({ defaultModels: {} }),
    });
    expect(result).toBe("auto");
  });
});
