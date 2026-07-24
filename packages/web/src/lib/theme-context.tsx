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
    // `localStorage` access can throw `SecurityError` (e.g. site data
    // blocked) — mirrors the pre-hydration <head> script's try/catch in
    // layout.tsx, which leaves the theme dark on throw. Match that: treat a
    // throw as "no stored value", which normalizeTheme(null) already
    // resolves to dark.
    let stored: string | null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      stored = null;
    }
    const next = normalizeTheme(stored);
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
      // React invokes this updater during the render phase (not inside the
      // click handler's try/catch, if any), and this provider has no error
      // boundary — a throw here would crash the whole tree, not just this
      // click, the same failure mode as the mount read above. Persistence
      // is best-effort; the theme still applies to this tab either way.
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Ignore: theme still applies below, just isn't persisted.
      }
      applyTheme(next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}
