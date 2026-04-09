---
name: frontend-codestyle
description: "Visual codestyle and design system rules for packages/web. Use when reviewing or implementing frontend changes."
---

# Frontend Codestyle

Visual style rules for the Spur web dashboard (`packages/web`).

## Use when

- Implementing or reviewing UI changes in `packages/web`
- Checking visual consistency across components

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

- **Font**: JetBrains Mono everywhere (monospace-first)
- **Body size**: 12px set on `<body>`, components inherit
- **Letter-spacing**: `0.02em` base, `0.06em`–`0.14em` for uppercase labels
- **Uppercase**: all labels, headers, button text, stat items
- **Tracking**: tighter on large headings (`-0.02em`), wider on small labels

### Spacing

- Tight: `px-2 py-1.5` for inputs/buttons, `px-2.5 py-2` for rows
- Use CSS custom properties for colors, not hardcoded hex in components
- Prefer `gap` over margin between siblings

### Borders and corners

- **All border-radius is 0px** (set in theme). No rounded corners anywhere.
- Use `border-[var(--color-border-default)]` for structural borders
- Use `border-[var(--color-border-subtle)]` for row separators

### Components

- **Buttons**: square, uppercase, bold. Primary = white bg + dark text. Secondary = bordered + text color. Danger = red border + red text.
- **Inputs/selects**: dark surface bg, default border, accent border on focus.
- **Session rows**: flat flex rows with `data-row` class for hover. Columns hide responsively (`hidden sm:inline`, `hidden md:inline`, `hidden lg:inline`).
- **Section headers**: colored dot + uppercase label + `border-t` divider line + count.
- **Stats bar**: horizontal, `border-y`, SVG icon per stat, secondary label, bold primary value. Colored when non-zero.
- **Modals**: fixed overlay `bg-black/60`, centered content box, ✕ close button.

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
- Placeholder text uses normal casing: "Filter sessions...", "Prompt for the new session..."

### Voice input

- Voice transcription inserts text directly into the target textarea (spawn prompt, session message) — no confirmation popup.
- Terminal is the exception: voice opens a confirmation popup before typing into tmux, because terminal input is irreversible.
- During transcription, the mic button shows a red spinning loader replacing the mic icon.
- Recording state: red border + red tint on the button.

### Do not

- Use `UNDER_SCORE` style in visible UI text — always use spaces
- Use `rounded-*` classes (radius is 0 globally)
- Hardcode hex colors in components — use CSS variables
- Use `text-sm`, `text-xs` etc. — body is 12px, components inherit
- Add gradient overlays or shadows heavier than `shadow-[0_8px_30px_rgba(0,0,0,0.3)]`
- Show empty attention zones — filter them out

### Visual verification

- Every UI change must include a manual browser test via Playwright before completion.
- Create a dedicated task/step for visual verification in every UI update checklist.
- Take screenshots of each touched state (idle, active, error, loading) and review them.
- Test on the Tailscale HTTPS URL, not just localhost, to catch secure-context issues.
