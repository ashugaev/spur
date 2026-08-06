---
name: frontend-codestyle
description: Visual codestyle and design system rules for packages/web. Use when reviewing or implementing frontend changes.
---

FRONTEND CODESTYLE

COLORS

  All `--color-*` tokens live in `packages/web/src/app/globals.css`
  (`@theme` block = dark/default, `:root[data-theme="light"]` = light).
  Read that file for names and values, never restate a hex here.
  Use the token, never a raw hex literal. New token needs both theme blocks.

TYPOGRAPHY

  Font stack: `--font-sans` / `--font-mono` in `globals.css` (`@theme`).
  Body size and base letter-spacing: `body {}` in `globals.css`, components inherit.
  Uppercase labels use `tracking-[0.06em]` through `tracking-[0.14em]` inline per
  component, large headings `tracking-[-0.02em]` inline — no single token, convention
  only, match the nearest existing component (`ConversationView.tsx`, `Dashboard.tsx`).
  Uppercase: all labels, headers, button text, stat items.

SPACING

  Tight: `px-2 py-1.5` for inputs/buttons, `px-2.5 py-2` for rows — Tailwind's
  default spacing scale, no project token, match the nearest existing component
  (`TagEditor.tsx`, `SessionRow.tsx`). Prefer `gap` over margin between siblings.

BORDERS AND CORNERS

  Border radius: `--radius-*` tokens in `globals.css` (`@theme`), all 0px. No
  rounded corners anywhere.
  Use `border-[var(--color-border-default)]` for structural borders, `border-[var(--color-border-subtle)]` for row separators.

COMPONENTS

  Buttons: square, uppercase, bold. Primary = white bg + dark text. Secondary = bordered + text color. Danger = red border + red text.
  Inputs/selects: dark surface bg, default border, accent border on focus.
  Session rows: flat flex rows with `data-row` class for hover. Columns hide responsively (`hidden sm:inline`, `hidden md:inline`, `hidden lg:inline`).
  Section headers: colored dot + uppercase label + `border-t` divider line + count.
  Stats bar: horizontal, `border-y`, SVG icon per stat, secondary label, bold primary value, colored when non-zero. Modals: fixed overlay `bg-black/60`, centered content box, ✕ close button.

ICONS

  Inline SVG, not icon fonts, stroke-based with `strokeWidth="1.5"` (GitHub/Jira icons use `fill="currentColor"` instead). 16px (`h-4 w-4`) for stats, 12px (`h-3 w-3`) for row-level — Tailwind scale, no project token, match the nearest existing icon usage.

RESPONSIVE BREAKPOINTS

  Tailwind's default `sm`/`md`/`lg` (640/768/1024), unmodified in this repo.

  `<sm`        Mobile        Header stacks, project/agent columns hidden, stats wrap, status hidden
  `sm–md`      Small tablet  Project column shows, tracker/PR links show
  `md–lg`      Tablet        Agent column shows
  `lg+`        Desktop       Branch column shows, full layout

TEXT STYLE

  UI labels use normal spaces ("Spawn Session", "Needs Input", "All Projects"), never underscores. Button text is always uppercase via the `uppercase` class; placeholder text uses normal casing ("Filter...", "Prompt...").

VOICE INPUT

  Voice transcription inserts text directly into the target textarea (spawn prompt, session message) — no confirmation popup. Terminal is the exception: voice opens a confirmation popup before typing into tmux.
  During transcription the mic button shows a red spinning loader replacing the mic icon; recording state adds a red border + red tint on the button.

COLOR LITERALS POLICY

  Color literals (hex, `rgb`, `rgba`, `hsl`, Tailwind `*-white/N`, `*-black/N`, `*-red-*`, `*-zinc-*`, etc.) are only allowed in `packages/web/src/app/globals.css` inside `@theme { ... }` and in `packages/web/src/design/colors.ts`.
  Components, stylesheets, and metadata files reference the palette via `var(--color-*)` (CSS/Tailwind) or by importing from `@/design/colors` (TS that cannot use CSS vars: Next.js metadata, xterm `ITheme`, palette-guard tests). Adding a new color: add a `--color-*` token in `globals.css` first, then expose it via `@/design/colors` if TS needs it.

DO NOT

  Use `UNDER_SCORE` style in visible UI text — always use spaces.
  Use `rounded-*` classes (radius is 0 globally, see BORDERS AND CORNERS) or `text-sm`/`text-xs` etc. (body size set in `globals.css`, components inherit).
  Hardcode hex colors in components — use CSS variables.
  Add gradient overlays or shadows heavier than `shadow-[0_8px_30px_var(--color-shadow-menu)]`, or show empty attention zones — filter them out.

VALIDATION

`packages/web` has two mandatory test layers, both green before completion: Vitest unit/component (`pnpm --dir packages/web test`), Playwright E2E (`pnpm --dir packages/web exec playwright test` on the isolated-ui sidecar).

  Playwright E2E covers 100% of UI surfaces. Each new or changed UI surface requires matching E2E coverage in `packages/web/tests/` in the same commit; existing scenarios must stay green.
  Build must pass: `pnpm --dir packages/web build`.
  Manual browser check via Chrome automation: dev server up, navigate to `localhost` (and the Tailscale HTTPS URL when secure-context matters), verify touched scenarios visually. Use the official Playwright MCP agent (`playwright-test-generator`) for new E2E tests.
  Capture screenshots for each touched state (idle, active, error, loading) and review them.
