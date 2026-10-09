"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { Theme } from "@/design/colors";

export type { Theme };
export type ThemeMode = "auto" | Theme;

export const THEME_STORAGE_KEY = "spur:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  mode: ThemeMode;
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
}

const defaultValue: ThemeContextValue = {
  mode: "auto",
  theme: "dark",
  setMode: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(defaultValue);

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function normalizeTheme(value: string | null, systemDark: boolean): { mode: ThemeMode; theme: Theme } {
  if (value === "light" || value === "dark") return { mode: value, theme: value };
  return { mode: "auto", theme: systemDark ? "dark" : "light" };
}

function systemIsDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return true;
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<{ mode: ThemeMode; theme: Theme }>(() => ({
    mode: "auto",
    theme: "dark",
  }));

  // Read storage again after hydration: React recovery can replace the root
  // attribute set by the blocking head script.
  useLayoutEffect(() => {
    let stored: string | null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      stored = null;
    }
    const next = normalizeTheme(stored, systemIsDark());
    setSelection(next);
    applyTheme(next.theme);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = normalizeTheme(event.newValue, systemIsDark());
      setSelection(next);
      applyTheme(next.theme);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (selection.mode !== "auto") return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      const next = normalizeTheme("auto", event.matches);
      setSelection(next);
      applyTheme(next.theme);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [selection.mode]);

  const setMode = useCallback((mode: ThemeMode) => {
    const next = normalizeTheme(mode, systemIsDark());
    setSelection(next);
    applyTheme(next.theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // The selection still applies to this tab.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ ...selection, setMode }}>{children}</ThemeContext.Provider>
  );
}
