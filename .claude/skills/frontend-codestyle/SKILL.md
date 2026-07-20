---
name: frontend-codestyle
description: Visual codestyle and design system rules for packages/web. Use when reviewing or implementing frontend changes.
---

# Frontend Codestyle

## Design system

### Colors (defined in `globals.css` `@theme`)

| Token | Value | Use |
|---|---|---|
| `--color-bg-base` | `#0D0D0E` | Page background |
| `--color-bg-surface` | `rgba(17,17,18,0.8)` | Cards, panels, inputs |
| `--color-bg-elevated` | `rgba(23,23,26,0.9)` | Elevated surfaces |
| `--color-border-subtle` | `rgba(35,35,38,0.6)` | Row dividers |
| `--color-border-default` | `rgba(35,35,38,1)` | Input borders, section borders |
| `--color-border-strong` | `rgba(50,50,54,1)` | Emphasized borders |
| `--color-text-primary` | `#E1E1E1` | Headings, values, primary text |
| `--color-text-secondary` | `#A1A1A1` | Body text, labels |
| `--color-text-tertiary` | `#555558` | Dim labels, metadata |
| `--color-text-inverse` | `#0D0D0E` | Text on white buttons |
| `--color-accent` | `#FFFFFF` | Primary interactive (buttons, links) |
| `--color-status-error` | `#FF4D4D` | Error, needs-input |
| `--color-status-attention` | `#FFD700` | Warning, pending |
| `--color-status-working` | `#58a6ff` | Active/working state |
| `--color-status-ready` | `#3fb950` | Online, complete |
| `--color-accent-orange` | `#d18616` | Review state |

### Typography

- Font: JetBrains Mono everywhere (monospace-first)
- Body size: 12px set on `<body>`, components inherit
- Letter-spacing: `0.02em` base, `0.06em`–`0.14em` for uppercase labels
- Uppercase: all labels, headers, button text, stat items
- Tracking: tighter on large headings (`-0.02em`), wider on small labels

### Spacing

- Tight: `px-2 py-1.5` for inputs/buttons, `px-2.5 py-2` for rows
- Use CSS custom properties for colors, not hardcoded hex in components
- Prefer `gap` over margin between siblings

### Borders and corners

- All border-radius is 0px (set in theme). No rounded corners anywhere.
- Use `border-[var(--color-border-default)]` for structural borders
- Use `border-[var(--color-border-subtle)]` for row separators

### Components

- Buttons: square, uppercase, bold. Primary = white bg + dark text. Secondary = bordered + text color. Danger = red border + red text.
- Inputs/selects: dark surface bg, default border, accent border on focus.
- Session rows: flat flex rows with `data-row` class for hover. Columns hide responsively (`hidden sm:inline`, `hidden md:inline`, `hidden lg:inline`).
- Section headers: colored dot + uppercase label + `border-t` divider line + count.
- Stats bar: horizontal, `border-y`, SVG icon per stat, secondary label, bold primary value. Colored when non-zero.
- Modals: fixed overlay `bg-black/60`, centered content box, ✕ close button.

### Icons

- Use inline SVG, not icon fonts. Keep icons 16px (`h-4 w-4`) for stats, 12px (`h-3 w-3`) for row-level.
- Stroke-based icons with `strokeWidth="1.5"`.
- GitHub and Jira icons use `fill="currentColor"`.

### Responsive breakpoints

| Breakpoint | Width | What changes |
|---|---|---|
| `<sm` (640) | Mobile | Header stacks, project/agent columns hidden, stats wrap, status hidden |
| `sm–md` | Small tablet | Project column shows, tracker/PR links show |
| `md–lg` | Tablet | Agent column shows |
| `lg+` | Desktop | Branch column shows, full layout |

### Text style

- Use normal spaces in UI labels: "Spawn Session", "Needs Input", "All Projects" — not underscores.
- Button text is always uppercase via `uppercase` class.
- Placeholder text uses normal casing: "Filter...", "Prompt..."

### Voice input

- Voice transcription inserts text directly into the target textarea (spawn prompt, session message) — no confirmation popup.
- Terminal is the exception: voice opens a confirmation popup before typing into tmux, because terminal input is irreversible.
- During transcription, the mic button shows a red spinning loader replacing the mic icon.
- Recording state: red border + red tint on the button.

### Color literals policy

- Color literals (hex, `rgb`, `rgba`, `hsl`, Tailwind `*-white/N`, `*-black/N`, `*-red-*`, `*-zinc-*`, etc.) are only allowed in `packages/web/src/app/globals.css` inside `@theme { ... }` and in `packages/web/src/design/colors.ts`.
- Components, stylesheets, and metadata files reference the palette via `var(--color-*)` (CSS/Tailwind) or by importing from `@/design/colors` (TS that cannot use CSS vars: Next.js metadata, xterm `ITheme`, palette-guard tests).
- Adding a new color means adding a `--color-*` token in `globals.css` first, then exposing it via `@/design/colors` if TS needs it.

### Do not

- Use `UNDER_SCORE` style in visible UI text — always use spaces
- Use `rounded-*` classes (radius is 0 globally)
- Hardcode hex colors in components — use CSS variables
- Use `text-sm`, `text-xs` etc. — body is 12px, components inherit
- Add gradient overlays or shadows heavier than `shadow-[0_8px_30px_rgba(0,0,0,0.3)]`
- Show empty attention zones — filter them out

### Validation

`packages/web` has two mandatory test layers; both must stay green before completion:

- Vitest unit/component — `pnpm --dir packages/web test`
- Playwright E2E — `pnpm --dir packages/web exec playwright test` on the isolated-ui sidecar

Playwright E2E covers 100% of UI surfaces. Every new or changed UI surface requires matching E2E coverage in `packages/web/tests/` in the same commit; existing scenarios must stay green.

- Build must pass: `pnpm --dir packages/web build`.
- Every visible-behavior change updates `packages/web/UI_TEST_SCENARIOS.md` in the same commit.
- Run a manual browser check via Chrome automation: dev server up, navigate to `localhost` (and the Tailscale HTTPS URL when secure-context matters), verify touched scenarios visually.
- Use the official Playwright MCP agent (`playwright-test-generator`) for new E2E tests.
- Capture screenshots for each touched state (idle, active, error, loading) and review them.
