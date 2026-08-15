import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSpawnDraft,
  readSpawnDraft,
  writeSpawnDraft,
  SPAWN_DRAFT_STORAGE_KEY,
  type SpawnDraft,
} from "@/lib/spawn-draft";

const NOW = Date.UTC(2026, 7, 5);

const draft: SpawnDraft = {
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
  sessionMode: "manager",
};

describe("spawn draft storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves and restores a versioned draft", () => {
    writeSpawnDraft(draft, window.localStorage, NOW);

    expect(readSpawnDraft(window.localStorage, NOW)).toEqual(draft);
    expect(window.localStorage.getItem(SPAWN_DRAFT_STORAGE_KEY)).toContain('"version":2');
  });

  it.each([
    ["malformed", "not-json"],
    ["old schema", JSON.stringify({ ...draft, version: 0, savedAt: NOW })],
    [
      "a pre-existing v1 draft (superseded by the retired default workspace mode fix)",
      JSON.stringify({ ...draft, version: 1, savedAt: NOW }),
    ],
    ["stale", JSON.stringify({ ...draft, version: 2, savedAt: NOW - 31 * 24 * 60 * 60 * 1_000 })],
    [
      "a current-version draft holding the retired default workspace mode",
      JSON.stringify({ ...draft, workspaceMode: "default", version: 2, savedAt: NOW }),
    ],
    [
      "a current-version draft with a non-string sessionMode",
      JSON.stringify({ ...draft, sessionMode: 42, version: 2, savedAt: NOW }),
    ],
  ])("discards %s storage", (_label, value) => {
    window.localStorage.setItem(SPAWN_DRAFT_STORAGE_KEY, value);

    expect(readSpawnDraft(window.localStorage, NOW)).toBeNull();
    expect(window.localStorage.getItem(SPAWN_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("discards a stored draft with undefined sessionMode", () => {
    const { sessionMode: _sessionMode, ...draftWithoutSessionMode } = draft;
    window.localStorage.setItem(
      SPAWN_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...draftWithoutSessionMode, version: 2, savedAt: NOW }),
    );

    expect(readSpawnDraft(window.localStorage, NOW)).toBeNull();
    expect(window.localStorage.getItem(SPAWN_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("discards a stored draft with a non-string sessionMode", () => {
    window.localStorage.setItem(
      SPAWN_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...draft, sessionMode: 42, version: 2, savedAt: NOW }),
    );

    expect(readSpawnDraft(window.localStorage, NOW)).toBeNull();
    expect(window.localStorage.getItem(SPAWN_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("restores a draft with sessionMode: null", () => {
    const nullModeDraft = { ...draft, sessionMode: null };
    writeSpawnDraft(nullModeDraft, window.localStorage, NOW);

    const restored = readSpawnDraft(window.localStorage, NOW);
    expect(restored).not.toBeNull();
    expect(restored?.sessionMode).toBeNull();
    expect(restored?.prompt).toBe(draft.prompt);
  });

  it("clears the stored draft", () => {
    writeSpawnDraft(draft, window.localStorage, NOW);
    expect(readSpawnDraft(window.localStorage, NOW)).not.toBeNull();

    clearSpawnDraft(window.localStorage);

    expect(readSpawnDraft(window.localStorage, NOW)).toBeNull();
  });
});
