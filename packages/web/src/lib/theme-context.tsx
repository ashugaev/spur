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

export const THEME_STORAGE_KEY = "spur:theme";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const defaultValue: ThemeContextValue = {
  theme: "dark",
  toggleTheme: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(defaultValue);

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function applyTheme(next: Theme) {
  if (next === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function normalizeTheme(value: string | null): Theme {
  return value === "light" ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  // `localStorage` is the single source of truth, not the `data-theme`
  // attribute the pre-hydration <head> script set: a hydration mismatch
  // elsewhere in the tree can make React wipe attributes it never rendered
  // itself, silently resetting a light theme back to dark. Reading storage
  // directly (in a layout effect, so it runs pre-paint) keeps the theme
  // correct independent of that recovery re-render.
  useLayoutEffect(() => {
    const next = normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
    setThemeState(next);
    applyTheme(next);
  }, []);

  // Cross-tab sync: mirror theme changes made in other tabs. The `storage`
  // event fires only in other documents, so this never loops with our own
  // writes; we update state + DOM but do not write back to localStorage.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = normalizeTheme(event.newValue);
      setThemeState(next);
      applyTheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next = current === "light" ? "dark" : "light";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}
