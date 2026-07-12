import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLastAgentSelection } from "@/hooks/useLastAgentSelection";

const STORAGE_KEY = "spur:last-agent-model";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useLastAgentSelection", () => {
  it("defaults to no last agent and an empty model map when storage is empty", () => {
    const { result } = renderHook(() => useLastAgentSelection());
    expect(result.current.lastAgent).toBeNull();
    expect(result.current.modelByAgent).toEqual({});
  });

  it("defaults defensively when the stored JSON is invalid", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useLastAgentSelection());
    expect(result.current.lastAgent).toBeNull();
    expect(result.current.modelByAgent).toEqual({});
  });

  it("ignores an unknown/invalid stored agent name", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lastAgent: "not-a-real-agent", modelByAgent: { claude: "sonnet" } }),
    );
    const { result } = renderHook(() => useLastAgentSelection());
    expect(result.current.lastAgent).toBeNull();
    expect(result.current.modelByAgent).toEqual({ claude: "sonnet" });
  });

  it("recordAgent persists lastAgent under the storage key", () => {
    const { result } = renderHook(() => useLastAgentSelection());
    act(() => result.current.recordAgent("codex"));
    expect(result.current.lastAgent).toBe("codex");
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      lastAgent?: string;
    };
    expect(stored.lastAgent).toBe("codex");
  });

  it("recordModel persists modelByAgent[agent] under the storage key", () => {
    const { result } = renderHook(() => useLastAgentSelection());
    act(() => result.current.recordModel("claude", "opus"));
    expect(result.current.modelByAgent).toEqual({ claude: "opus" });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      modelByAgent?: Record<string, string>;
    };
    expect(stored.modelByAgent).toEqual({ claude: "opus" });
  });

  it("updates state on a storage event from another tab", () => {
    const { result } = renderHook(() => useLastAgentSelection());
    act(() => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ lastAgent: "cursor", modelByAgent: { cursor: "auto" } }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    expect(result.current.lastAgent).toBe("cursor");
    expect(result.current.modelByAgent).toEqual({ cursor: "auto" });
  });

  it("ignores storage events for unrelated keys", () => {
    const { result } = renderHook(() => useLastAgentSelection());
    act(() => {
      window.localStorage.setItem("spur:some-other-key", "value");
      window.dispatchEvent(new StorageEvent("storage", { key: "spur:some-other-key" }));
    });
    expect(result.current.lastAgent).toBeNull();
    expect(result.current.modelByAgent).toEqual({});
  });
});
