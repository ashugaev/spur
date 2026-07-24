import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "@/lib/theme-context";

function renderProvider() {
  return renderHook(() => useTheme(), { wrapper: ThemeProvider });
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("defaults to dark when the DOM has no data-theme attribute", () => {
    const { result } = renderProvider();
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("restores state from localStorage on mount, even when data-theme is absent", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderProvider();
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("storage wins over a stale data-theme attribute", () => {
    // Simulates a hydration-recovery re-render that wiped `data-theme` from
    // the DOM (or left a stale value) while localStorage was never touched.
    document.documentElement.dataset.theme = "light";
    const { result } = renderProvider();
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("toggleTheme flips theme, writes localStorage, and sets data-theme", () => {
    const { result } = renderProvider();
    expect(result.current.theme).toBe("dark");

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("useTheme outside a provider returns the safe dark default and no-op setters", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(() => result.current.toggleTheme()).not.toThrow();
  });

  it("syncs from a storage event fired by another tab", () => {
    const { result } = renderProvider();
    expect(result.current.theme).toBe("dark");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "light" }),
      );
    });

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }),
      );
    });

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ignores storage events for unrelated keys", () => {
    const { result } = renderProvider();
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "spur:something-else", newValue: "light" }),
      );
    });
    expect(result.current.theme).toBe("dark");
  });
});
