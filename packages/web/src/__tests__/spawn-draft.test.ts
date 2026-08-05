import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSpawnDraft,
  readSpawnDraft,
  spawnDraftStorageKey,
  writeSpawnDraft,
  type SpawnDraft,
} from "@/lib/spawn-draft";

const NOW = Date.UTC(2026, 7, 5);

const draft: SpawnDraft = {
  projectId: "api/team",
  prompt: "Fix reconnect state loss",
  agent: "codex",
  model: "gpt-5.6-codex",
  branch: "feature/spawn-draft",
  branchIsExplicit: true,
  workspaceMode: "worktree",
  defaultBranch: "main",
  planMode: true,
  selfDestruct: true,
  selfDestructConditions: "After CI passes",
  steps: ["Implement", "Test"],
  trackerUrl: "https://example.com/issues/1",
};

describe("spawn draft storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves and restores a project-scoped versioned draft", () => {
    writeSpawnDraft(draft, window.localStorage, NOW);

    expect(readSpawnDraft(draft.projectId, window.localStorage, NOW)).toEqual(draft);
    expect(readSpawnDraft("other-project", window.localStorage, NOW)).toBeNull();
    expect(window.localStorage.getItem(spawnDraftStorageKey(draft.projectId))).toContain(
      '"version":1',
    );
  });

  it.each([
    ["malformed", "not-json"],
    ["old schema", JSON.stringify({ ...draft, version: 0, savedAt: NOW })],
    [
      "stale",
      JSON.stringify({ ...draft, version: 1, savedAt: NOW - 31 * 24 * 60 * 60 * 1_000 }),
    ],
  ])("discards %s storage", (_label, value) => {
    const key = spawnDraftStorageKey(draft.projectId);
    window.localStorage.setItem(key, value);

    expect(readSpawnDraft(draft.projectId, window.localStorage, NOW)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("clears only the confirmed project's draft", () => {
    writeSpawnDraft(draft, window.localStorage, NOW);
    writeSpawnDraft({ ...draft, projectId: "web" }, window.localStorage, NOW);

    clearSpawnDraft(draft.projectId, window.localStorage);

    expect(readSpawnDraft(draft.projectId, window.localStorage, NOW)).toBeNull();
    expect(readSpawnDraft("web", window.localStorage, NOW)?.prompt).toBe(draft.prompt);
  });
});
