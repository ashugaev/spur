/**
 * Source of truth for color literals used outside CSS — i.e. Next.js metadata
 * compiled at build time and the xterm terminal theme that consumes JS objects.
 *
 * Every value here mirrors a `--color-*` token declared in
 * `src/app/globals.css` under `@theme`. Keep the two files in sync.
 *
 * Components must not import literal colors. They reference the CSS variables
 * directly (e.g. `bg-[var(--color-bg-base)]`).
 */

import type { ITheme } from "xterm";

/** Mirrors `--color-bg-base`. Used by Next.js manifest / viewport / icon routes. */
export const BG_BASE_HEX = "#0d0d0e";

/**
 * Brand spark glyph path, a 24-unit viewBox path. Shared between the header
 * brand mark (`Dashboard.tsx`), the static app icon (`src/app/icon.tsx`) and
 * the dynamic status favicon (`SessionDetail.tsx`) so all three render
 * pixel-identical geometry. Lives here rather than in the route file because
 * `icon.tsx` imports `next/og` (server/edge-only, pulls in `fs`), which
 * cannot be bundled into a client component.
 *
 * Eight rays drawn outward from center; the four diagonal rays use a
 * shortened per-axis offset of 6.4 (diagonal length ~9.05, via the
 * Pythagorean 6.4*sqrt(2)) against the four axis-aligned rays' length of 10,
 * so they read as slightly shorter. Render with `strokeLinecap="round"` so
 * every ray gets a rounded tip.
 */
export const SPARK_GLYPH_PATH =
  "M12 12V2 M12 12h10 M12 12v10 M12 12H2 M12 12l6.4 6.4 M12 12 5.6 5.6 M12 12l6.4-6.4 M12 12 5.6 18.4";

/** Mirrors `--color-terminal-bg` (dark). Used by the xterm `ITheme` and the container div. */
export const TERMINAL_BG_HEX = "#0a0a0f";

/** UI theme name, kept in one place so `lib/theme-context.tsx` re-exports rather than redefines it. */
export type Theme = "dark" | "light";

/**
 * Full xterm `ITheme`, one per `Theme`. Passed straight to the Terminal
 * constructor and swapped on the live instance when the theme changes.
 * The ANSI entries are terminal-specific and do not appear in `@theme`; they
 * live here because xterm is the only consumer.
 */
export const TERMINAL_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: TERMINAL_BG_HEX,
    foreground: "#d4d4d8",
    cursor: "#5b7ef8",
    cursorAccent: TERMINAL_BG_HEX,
    selectionBackground: "rgba(91, 126, 248, 0.3)",
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
    black: "#1a1a24",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#5b7ef8",
    magenta: "#a371f7",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#50506a",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#7b9cfb",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#eeeef5",
  },
  light: {
    background: "#f6f8fa",
    foreground: "#1f2328",
    cursor: "#0969da",
    cursorAccent: "#f6f8fa",
    selectionBackground: "rgba(9, 105, 218, 0.2)",
    selectionInactiveBackground: "rgba(31, 35, 40, 0.1)",
    black: "#24292f",
    red: "#cf222e",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#116329",
    brightYellow: "#4d2d00",
    brightBlue: "#0550ae",
    brightMagenta: "#6639ba",
    brightCyan: "#1b7c83",
    brightWhite: "#24292f",
  },
};

/** Looks up the xterm `ITheme` for a UI theme name. */
export function getTerminalTheme(theme: Theme): ITheme {
  return TERMINAL_THEMES[theme];
}
