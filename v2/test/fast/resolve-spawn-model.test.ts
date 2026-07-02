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
    triggers: {},
    ...overrides,
  };
}

describe("resolveSpawnModel", () => {
  it("returns the explicit request model regardless of agent", () => {
    const result = resolveSpawnModel({
      requestModel: "opus",
      resolvedAgent: "cursor",
      project: project({ defaultAgent: "codex", defaultModel: "gpt-5.5" }),
    });
    expect(result).toBe("opus");
  });

  it("applies project defaultModel only when resolvedAgent is the default agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({ defaultAgent: "codex", defaultModel: "gpt-5.5" }),
    });
    expect(result).toBe("gpt-5.5");
  });

  it("does not carry defaultModel onto a different agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "claude",
      project: project({ defaultAgent: "codex", defaultModel: "gpt-5.5" }),
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no model is configured", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({ defaultAgent: "codex" }),
    });
    expect(result).toBeUndefined();
  });
});
