/**
 * Snapshot of every color the `packages/web` UI currently draws with.
 *
 * - The canonical palette is `@theme` in `src/app/globals.css`. The groups below
 *   mirror that theme and surface it to TypeScript as `{ var, hex | rgba }` so
 *   callers can cross-reference the token name against the raw value.
 * - Groups after the theme record literals that live outside the theme
 *   (component overlays, shadows, manifest/favicon backgrounds, the xterm
 *   palette). They exist so the migration audit can see them in one place.
 * - Nothing in the app imports this file yet. It is intentionally a read-only
 *   audit surface until the background migration lands.
 */

export const BG = {
  base: { var: "var(--color-bg-base)", hex: "#0d0d0e" },
  surface: { var: "var(--color-bg-surface)", rgba: "rgba(17, 17, 18, 0.8)" },
  elevated: { var: "var(--color-bg-elevated)", rgba: "rgba(23, 23, 26, 0.9)" },
} as const;

export const BORDER = {
  subtle: { var: "var(--color-border-subtle)", rgba: "rgba(35, 35, 38, 0.6)" },
  default: { var: "var(--color-border-default)", rgba: "rgba(35, 35, 38, 1)" },
  strong: { var: "var(--color-border-strong)", rgba: "rgba(50, 50, 54, 1)" },
} as const;

export const TEXT = {
  primary: { var: "var(--color-text-primary)", hex: "#e1e1e1" },
  secondary: { var: "var(--color-text-secondary)", hex: "#a1a1a1" },
  tertiary: { var: "var(--color-text-tertiary)", hex: "#555558" },
  inverse: { var: "var(--color-text-inverse)", hex: "#0d0d0e" },
} as const;

export const ACCENT = {
  default: { var: "var(--color-accent)", hex: "#ffffff" },
  hover: { var: "var(--color-accent-hover)", rgba: "rgba(255, 255, 255, 0.8)" },
  violet: { var: "var(--color-accent-violet)", hex: "#a371f7" },
} as const;

export const STATUS = {
  working: { var: "var(--color-status-working)", hex: "#58a6ff" },
  ready: { var: "var(--color-status-ready)", hex: "#3fb950" },
  attention: { var: "var(--color-status-attention)", hex: "#ffd700" },
  error: { var: "var(--color-status-error)", hex: "#ff4d4d" },
} as const;

/**
 * Overlays layered on dark surfaces. `bg-white/*` and `bg-black/*` are Tailwind
 * classes; the rgba values live in `globals.css` scrollbar / keyframe rules.
 */
export const OVERLAY = {
  rowHover: "rgba(255, 255, 255, 0.03)",
  scrollbarThumb: "rgba(255, 255, 255, 0.08)",
  scrollbarThumbHover: "rgba(255, 255, 255, 0.15)",
  scrollbarThumbActive: "rgba(255, 255, 255, 0.25)",
  activityPulse: "rgba(255, 255, 255, 0.45)",
  whiteHover: "bg-white/5",
  modalBackdrop: "bg-black/60",
  modalBackdropHeavy: "bg-black/70",
  shortcutHint: "text-black/55",
} as const;

export const SHADOW = {
  menu: "0 8px 30px rgba(0, 0, 0, 0.3)",
  modalSm: "0 4px 12px rgba(0, 0, 0, 0.5)",
  modalLg: "0 20px 60px rgba(0, 0, 0, 0.5)",
} as const;

/** Error/warn/success chips that currently bypass theme tokens for Tailwind defaults. */
export const SEMANTIC_CHIP = {
  errorBorder: "border-red-500/30",
  errorBg: "bg-red-500/[0.08]",
  errorText100: "text-red-100",
  errorText200: "text-red-200",
  warnBorder: "border-orange-400/30",
  warnText: "text-orange-200",
  alive: "bg-green-400",
} as const;

/** Inline-style backgrounds inside `ActivityDot` — tuned per status. */
export const ACTIVITY_DOT_BG = {
  error: "rgba(248, 81, 73, 0.14)",
  inactive: "rgba(72, 79, 88, 0.2)",
  working: "rgba(88, 166, 255, 0.10)",
  waiting: "rgba(210, 153, 34, 0.14)",
} as const;

/**
 * Literals that live outside the `@theme` block and will NOT move automatically
 * when `--color-bg-base` changes. Listed here so the migration audit can pair
 * each of them with an owner.
 */
export const STANDALONE = {
  /** Favicons, apple-icon, manifest, layout themeColor — all hardcode this. */
  manifestBg: "#0D0D0E",
  /** `DirectTerminal.tsx` container + xterm theme; intentionally bluer than body. */
  terminalBg: "#0a0a0f",
  terminalFg: "#d4d4d8",
  terminalCursor: "#5b7ef8",
  terminalSelection: "rgba(91, 126, 248, 0.3)",
  terminalSelectionInactive: "rgba(128, 128, 128, 0.2)",
} as const;

/** Full 16-color ANSI palette the xterm terminal uses (standalone, not themed). */
export const TERMINAL_ANSI = {
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
} as const;
