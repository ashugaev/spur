import { describe, expect, it } from "vitest";
import { resolveSpawnEffort, resolveSpawnModel } from "../../src/session-service.js";
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
      project: project({ agentDefaults: { codex: { model: "gpt-5.5" } } }),
    });
    expect(result).toBe("opus");
  });

  it("applies the agentDefaults model for the resolved agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({
        agentDefaults: { codex: { model: "gpt-5.5" }, cursor: { model: "composer-2.5" } },
      }),
    });
    expect(result).toBe("gpt-5.5");
  });

  it("does not bleed one agent's default model onto another agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "claude",
      project: project({ agentDefaults: { codex: { model: "gpt-5.5" } } }),
    });
    expect(result).toBe("sonnet");
  });

  it("returns undefined when no default model is configured for the agent", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({ agentDefaults: {} }),
    });
    expect(result).toBeUndefined();
  });

  it("applies auto as the Cursor default when no Cursor default is configured", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "cursor",
      project: project({ agentDefaults: {} }),
    });
    expect(result).toBe("auto");
  });

  it("applies sonnet as the Claude default when no config is set at all", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "claude",
      project: project({}),
    });
    expect(result).toBe("sonnet");
  });

  it("still applies auto as the Cursor default when no config is set at all", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "cursor",
      project: project({}),
    });
    expect(result).toBe("auto");
  });

  it("leaves Codex with no code-level default model", () => {
    const result = resolveSpawnModel({
      requestModel: undefined,
      resolvedAgent: "codex",
      project: project({}),
    });
    expect(result).toBeUndefined();
  });
});

describe("resolveSpawnEffort", () => {
  it("returns the explicit request effort regardless of agent", () => {
    const result = resolveSpawnEffort({
      requestEffort: "low",
      resolvedAgent: "cursor",
      project: project({ agentDefaults: { cursor: { effort: "max" } } }),
    });
    expect(result).toBe("low");
  });

  it("applies the agentDefaults effort for the resolved agent", () => {
    const result = resolveSpawnEffort({
      requestEffort: undefined,
      resolvedAgent: "cursor",
      project: project({ agentDefaults: { cursor: { effort: "max" } } }),
    });
    expect(result).toBe("max");
  });

  it("does not bleed one agent's default effort onto another agent", () => {
    const result = resolveSpawnEffort({
      requestEffort: undefined,
      resolvedAgent: "cursor",
      project: project({ agentDefaults: { claude: { effort: "medium" } } }),
    });
    expect(result).toBeUndefined();
  });

  it("applies high as the Claude default when no config is set at all", () => {
    const result = resolveSpawnEffort({
      requestEffort: undefined,
      resolvedAgent: "claude",
      project: project({}),
    });
    expect(result).toBe("high");
  });

  it("does not apply a code-level default for Cursor", () => {
    const result = resolveSpawnEffort({
      requestEffort: undefined,
      resolvedAgent: "cursor",
      project: project({}),
    });
    expect(result).toBeUndefined();
  });

  it("does not apply a code-level default for Codex", () => {
    const result = resolveSpawnEffort({
      requestEffort: undefined,
      resolvedAgent: "codex",
      project: project({}),
    });
    expect(result).toBeUndefined();
  });

  it("throws when an explicit effort is requested for Codex", () => {
    expect(() =>
      resolveSpawnEffort({
        requestEffort: "high",
        resolvedAgent: "codex",
        project: project({}),
      }),
    ).toThrow('effort is not supported for agent "codex"');
  });

  it("does not throw for Codex when no effort is requested", () => {
    const result = resolveSpawnEffort({
      requestEffort: undefined,
      resolvedAgent: "codex",
      project: project({}),
    });
    expect(result).toBeUndefined();
  });
});
