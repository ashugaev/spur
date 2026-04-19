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
export const BG_BASE_HEX = "#27272a";

/** Mirrors `--color-terminal-bg`. Used by the xterm `ITheme` and the container div. */
export const TERMINAL_BG_HEX = "#18181b";

/**
 * Full xterm `ITheme`. Passed straight to the Terminal constructor.
 * The ANSI entries are terminal-specific and do not appear in `@theme`; they
 * live here because xterm is the only consumer.
 */
export const TERMINAL_THEME: ITheme = {
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
};
