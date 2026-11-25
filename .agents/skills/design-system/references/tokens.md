TOKENS

Values: globals.css. This file names roles only. Planned values live here until their phase writes them to globals.css, then move out.


COLOR, CURRENT

  surface     --color-bg-base           page
              --color-bg-surface        panel, inline surface
              --color-bg-elevated       card, menu, popover, modal
              --color-terminal-bg       xterm container
  border      --color-border-subtle     row separator
              --color-border-default    card, divider, structural edge
              --color-border-strong     popover, menu edge
  text        --color-text-primary      values, titles
              --color-text-secondary    body copy, labels
              --color-text-tertiary     meta, counts, hints
              --color-text-inverse      label on accent or error fill
  input       --color-input-bg|text|border|placeholder    deprecate P3
  accent      --color-accent            links, primary fill, focus ring
              --color-accent-hover      primary hover
              --color-accent-violet     link-icons only
  overlay     --color-hover-overlay     hover fill
              --color-row-hover         data-row hover                deprecate P3
              --color-modal-backdrop    backdrop
              --color-scrollbar-thumb[-hover|-active]
              --color-activity-pulse    working dot pulse
  shadow      --color-shadow-menu|modal-sm|modal-lg   inputs to elevation, private from P2
  status      --color-status-working|ready|attention|error   dot, icon, border
  chip        --color-chip-error-bg|border|text, chip-warn-border|text, chip-alive   deprecate P3
  dot bg      --color-dot-bg-error|inactive|working|waiting|ready                    deprecate P3
  safe area   --safe-top|bottom|left|right
  radius      --radius-xs..xl, all 0
  font        --font-sans = --font-mono = JetBrains Mono stack


COLOR, PLANNED

  P1  --color-border-control                  control edge: input, secondary button, icon button
  P3  --color-status-inactive                 fifth tone
  P3  --color-status-<tone>-text              tone label, 4.5:1 on its own -bg
  P3  --color-status-<tone>-bg                color-mix(in srgb, tone 12%, transparent), one definition outside theme blocks
  P3  --color-status-<tone>-border            color-mix 30%, same

  Tone set replaces chip-* and dot-bg-*. Theme blocks define tone and tone-text only.


SCALES, PLANNED P2

Until P2: no token; match the nearest existing component (ConversationView.tsx, Dashboard.tsx, TagEditor.tsx, SessionRow.tsx) and pick the step this list names.

Tailwind v4 namespaces generate utilities: --text-label -> text-label, --tracking-label -> tracking-label, --shadow-overlay -> shadow-overlay, --radius-dot -> rounded-dot. z, control, icon have no namespace: use z-(--z-modal), h-(--control-md).

  size       --text-display 22px   titles             folds 22, 26, xl, 2xl
             --text-title   16px   section lead        folds 16, base
             --text-body    12px   body default        folds 12, sm, xs
             --text-meta    11px   time, hints, code   folds 11
             --text-label   10px   caps labels         folds 10, 9, 8
  tracking   --tracking-display -0.02em
             --tracking-body     0.02em   body default
             --tracking-meta     0.08em   folds 0.06
             --tracking-label    0.12em   folds 0.1
             --tracking-caps     0.14em   section, modal header; folds 0.18, 0.3
  weight     400 body, 500 toast title, 700 labels and values; semibold folds to 700
  shadow     --shadow-raised   0 4px 12px shadow-modal-sm   status card; folds 0_8_24
             --shadow-overlay  0 8px 30px shadow-menu       menu, popover, toast; folds 0_6_20
             --shadow-modal    0 20px 60px shadow-modal-lg  modal
  radius     --radius-dot 9999px   status dots only
  z          --z-raised 10, --z-sticky 20, --z-popover 30, --z-modal 50, --z-modal-stack 60, --z-toast 90, --z-blocking 100
             folds 35, 40 -> popover; 85 -> toast
  control    --control-md 32, --control-sm 28, --control-xs 24, --control-2xs 20
             under 24: pad hit area to 24 (WCAG 2.5.8)
  icon       --icon-sm 12 row, --icon-md 14 control, --icon-lg 16 stat; inline SVG, stroke 1.5, close 2; GitHub, GitLab, Jira logos fill currentColor
  motion     --duration-fast 150ms color, --duration-base 200ms transform
             loops: pulse 2s, loader 1.2s, spin 0.8s; every keyframe class has a prefers-reduced-motion fallback


SPACE

  Tailwind scale, no tokens. Steps in use: 0.5 1 1.5 2 2.5 3 4 6.
  Button px-2 py-1. Input and row px-2.5 py-2. Menu item px-3 py-1.5. Card and modal p-4.
  gap over margin between siblings.


BREAKPOINTS

  Tailwind default sm 640, md 768, lg 1024. Column map: patterns.md.
