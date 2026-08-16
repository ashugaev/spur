import { describe, expect, it } from "vitest";
import { resolvePreselectedModelId } from "@/lib/spawn-defaults";
import type { AgentModel } from "@/lib/types";

const MODELS: AgentModel[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

function resolve(overrides: {
  favoriteIds?: ReadonlySet<string>;
  carry?: Parameters<typeof resolvePreselectedModelId>[0]["carry"];
  projectDefaultModelId?: string | null;
  models?: AgentModel[];
}) {
  return resolvePreselectedModelId({
    agent: "claude",
    models: MODELS,
    favoriteIds: new Set(),
    carry: null,
    projectDefaultModelId: null,
    ...overrides,
  });
}

describe("resolvePreselectedModelId", () => {
  it("rung 1: a carry naming the same agent beats favorites and the project default", () => {
    const result = resolve({
      carry: { agent: "claude", model: "sonnet" },
      favoriteIds: new Set(["haiku"]),
      projectDefaultModelId: "opus",
    });
    expect(result).toBe("sonnet");
  });

  it("rung 1b: a carry naming a different agent falls through", () => {
    const result = resolve({
      carry: { agent: "codex", model: "sonnet" },
      favoriteIds: new Set(["haiku"]),
    });
    expect(result).toBe("haiku");
  });

  it("rung 1c: a carry naming an id absent from the loaded list falls through", () => {
    const result = resolve({
      carry: { agent: "claude", model: "gpt-5.5" },
      favoriteIds: new Set(["haiku"]),
    });
    expect(result).toBe("haiku");
  });

  it("rung 2: the first favorite in list order beats the project default", () => {
    const result = resolve({
      favoriteIds: new Set(["haiku"]),
      projectDefaultModelId: "opus",
    });
    expect(result).toBe("haiku");
  });

  it("rung 3: the project default applies when there is no carry or favorite", () => {
    const result = resolve({ projectDefaultModelId: "sonnet" });
    expect(result).toBe("sonnet");
  });

  it("rung 3b: a project default absent from the loaded list falls through", () => {
    const result = resolve({ projectDefaultModelId: "gpt-5.5" });
    expect(result).toBe("opus");
  });

  it("rung 4: the first list entry applies when every higher rung is absent", () => {
    const result = resolve({});
    expect(result).toBe("opus");
  });

  it("returns null only when the loaded list is empty", () => {
    const result = resolve({ models: [], favoriteIds: new Set(["haiku"]) });
    expect(result).toBeNull();
  });
});
