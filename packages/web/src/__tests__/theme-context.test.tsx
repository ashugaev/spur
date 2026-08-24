import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("defaults to dark when localStorage has no stored theme", () => {
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

  it("resolves to dark, without throwing, when localStorage.getItem throws", () => {
    // Mirrors the pre-hydration <head> script's try/catch in layout.tsx,
    // which leaves the theme dark when `localStorage` access throws (e.g.
    // SecurityError with site data blocked). ThemeProvider is the outermost
    // provider with no error boundary, so an unguarded throw here would take
    // down the whole tree before first paint.
    const getItemSpy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    let hookResult: ReturnType<typeof renderProvider> | undefined;
    expect(() => {
      hookResult = renderProvider();
    }).not.toThrow();

    expect(hookResult?.result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    getItemSpy.mockRestore();
  });

  it("storage wins over a stale data-theme attribute", () => {
    // Simulates a hydration-recovery re-render that wiped `data-theme` from
    // the DOM (or left a stale value) while localStorage was never touched.
    // This is the sole unit-level guard for hydration-mismatch resilience:
    // it is the only test in this file that would fail if the provider went
    // back to trusting the DOM attribute instead of localStorage. The e2e
    // case at tests/theme.spec.ts ("... both survive a reload at
    // /?project=<id>") exercises the same property against a real browser.
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

  it("useTheme outside a provider returns the safe dark default and a no-op toggle", () => {
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
