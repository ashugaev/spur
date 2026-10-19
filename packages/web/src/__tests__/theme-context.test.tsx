import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, normalizeTheme, useTheme } from "@/lib/theme-context";

const originalMatchMedia = window.matchMedia;
let systemDark = false;
const listeners = new Set<(event: MediaQueryListEvent) => void>();

function setSystemDark(dark: boolean) {
  systemDark = dark;
  const event = { matches: dark } as MediaQueryListEvent;
  act(() => listeners.forEach((listener) => listener(event)));
}

function renderProvider() {
  return renderHook(() => useTheme(), { wrapper: ThemeProvider });
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    systemDark = false;
    listeners.clear();
    window.matchMedia = ((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && systemDark,
      media: query,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it("normalizes fixed values and uses OS color for absent, auto, and invalid values", () => {
    expect(normalizeTheme("light", true)).toEqual({ mode: "light", theme: "light" });
    expect(normalizeTheme("dark", false)).toEqual({ mode: "dark", theme: "dark" });
    for (const value of [null, "auto", "invalid"]) {
      expect(normalizeTheme(value, false)).toEqual({ mode: "auto", theme: "light" });
      expect(normalizeTheme(value, true)).toEqual({ mode: "auto", theme: "dark" });
    }
  });

  it("defaults to Auto and follows OS changes without writing storage", () => {
    const { result } = renderProvider();
    expect(result.current).toMatchObject({ mode: "auto", theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    setSystemDark(true);
    expect(result.current).toMatchObject({ mode: "auto", theme: "dark" });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("preserves stored fixed themes and ignores OS changes", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderProvider();
    expect(result.current).toMatchObject({ mode: "light", theme: "light" });
    setSystemDark(true);
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("rereads storage to repair a stale root attribute", () => {
    document.documentElement.dataset.theme = "light";
    const { result } = renderProvider();
    expect(result.current.theme).toBe("light");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const second = renderProvider();
    expect(second.result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("treats inaccessible storage as Auto and falls back to dark if media is unavailable", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    window.matchMedia = (() => {
      throw new Error("unavailable");
    }) as typeof window.matchMedia;
    const { result } = renderProvider();
    expect(result.current).toMatchObject({ mode: "auto", theme: "dark" });
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("selects and persists a mode; entering Auto rereads the current OS", () => {
    const { result } = renderProvider();
    act(() => result.current.setMode("dark"));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    setSystemDark(false);
    expect(result.current.theme).toBe("dark");
    act(() => result.current.setMode("auto"));
    expect(result.current).toMatchObject({ mode: "auto", theme: "light" });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("auto");
  });

  it("syncs another tab's mode without writing it back", () => {
    const write = vi.spyOn(window.localStorage, "setItem");
    const { result } = renderProvider();
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }),
      ),
    );
    expect(result.current).toMatchObject({ mode: "dark", theme: "dark" });
    setSystemDark(true);
    act(() =>
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: null })),
    );
    expect(result.current).toMatchObject({ mode: "auto", theme: "dark" });
    expect(write).not.toHaveBeenCalled();
  });
});
