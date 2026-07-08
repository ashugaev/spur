import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSlashSuggestions } from "@/hooks/useSlashSuggestions";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSlashSuggestions", () => {
  it("does not fetch when disabled", () => {
    renderHook(() => useSlashSuggestions({ endpoint: "/api/suggestions", enabled: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("populates data when the fetch succeeds", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [{ id: "compact", label: "/compact" }] }),
    });

    const { result } = renderHook(() =>
      useSlashSuggestions({ endpoint: "/api/suggestions", enabled: true }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ items: [{ id: "compact", label: "/compact" }] });
    });
    expect(result.current.error).toBeNull();
  });

  it("populates error when the fetch responds non-ok", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "nope" }),
    });

    const { result } = renderHook(() =>
      useSlashSuggestions({ endpoint: "/api/suggestions", enabled: true }),
    );

    await waitFor(() => {
      expect(result.current.error).toBe("nope");
    });
  });
});
