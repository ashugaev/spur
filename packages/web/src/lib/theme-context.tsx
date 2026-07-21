"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { Theme } from "@/design/colors";

export type { Theme };

export const THEME_STORAGE_KEY = "spur:theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
}

const defaultValue: ThemeContextValue = {
  theme: "dark",
  setTheme: () => {},
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  // The pre-hydration <head> script already set `data-theme` from
  // localStorage before React mounts; sync state to it here rather than
  // re-reading localStorage, so state and DOM never disagree.
  useLayoutEffect(() => {
    setThemeState(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next = current === "light" ? "dark" : "light";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
