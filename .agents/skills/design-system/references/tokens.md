TOKENS

Names and roles. Values: design/tokens.css. Groups and contrast rules: registry.json.


COLOR

  surface   bg-base page, bg-surface panel, bg-elevated card menu modal, terminal-bg xterm
  border    border-subtle row separator, border-default card divider, border-strong popover menu icon button
  text      text-primary values titles inputs, text-secondary body labels, text-tertiary meta hints placeholders, text-inverse label on accent
  input     input-bg, input-border (field edge, 3:1)
  accent    accent links primary fill focus ring, accent-hover, accent-violet link-icons only
  overlay   hover-overlay hover and zebra, modal-backdrop, scrollbar-thumb*, activity-pulse
  shadow    shadow-menu, shadow-modal-sm, shadow-modal-lg: inputs to elevation only
  status    status-<tone> dot icon edge word; status-<tone>-bg tint; status-<tone>-border chip edge

  All names carry the --color- prefix. Tones: working, ready, attention, error, inactive.
  -bg and -border derive via color-mix; registry marks them derived. From TS: design/tone.ts.


SCALES

  text       text-label caps labels chips buttons, text-meta time hints code, text-body default, text-title section and dialog heads, text-display page titles
  tracking   tracking-display, tracking-body (body default), tracking-meta inline meta, tracking-label buttons fields, tracking-caps section and modal heads
  elevation  shadow-raised status card inline panel, shadow-overlay menu popover toast FAB, shadow-modal modal
  radius     square; rounded-dot for status dots only
  font       --font-sans = --font-mono, one family

  Arbitrary or named-Tailwind sizes, arbitrary tracking and shadows, other rounded-*: banned by registry.json banned.


NOT TOKENIZED

  Spacing, icon and control sizes: Tailwind scale. Steps in use: 0.5 1 1.5 2 2.5 3 4 6. gap over margin.
  Breakpoints: Tailwind default sm, md, lg. Column map: patterns.md.
  Layers: Tailwind z-10 .. z-50 plus z-[60] z-[85] z-[90] z-[100]; consolidation pending, roadmap.md.
  Motion: Tailwind transition default; keyframes in globals.css, each with a reduced-motion fallback.
  Safe area: --safe-top|bottom|left|right.
