TOKENS

Values: design/tokens.css. Role, group, contrast, status per token: design/registry.json. This file holds naming and placement only.


PLACEMENT

  first block (@theme)       every token; dark values for colors; scales; derived tokens
  second block (light)       color overrides only; same names as the first block minus derived
  derived                    color-mix of other tokens, defined once in the first block; registry marks derived
  design/tone.ts             TS access to the status tone set
  design/colors.ts           hex mirrors for TS-only consumers; guard keeps them equal


NAMING

  --color-<role>[-<variant>]     bg-*, border-*, text-*, input-*, accent*, status-<tone>[-bg|-border]
  --text-<role>                  size; utility text-<role>
  --tracking-<role>              letter spacing; utility tracking-<role>
  --shadow-<elevation>           raised, overlay, modal; utility shadow-<elevation>
  --radius-<shape>               square everywhere; dot for status dots

  Name by role, never by value or hue: --color-status-error, not --color-red.
  Tailwind v4 namespaces (--color, --text, --tracking, --shadow, --radius, --font) generate utilities; other prefixes need var().


ADDING A TOKEN

  1  Existing role covers the need: use it. Two tokens with one role: merge.
  2  Color: value in both blocks, or derived from existing tokens.
  3  Registry entry: group, role, since, contrast when used as text or field edge.
  4  Guard passes: sync, role, contrast.


NOT TOKENIZED

  Spacing, icon and control sizes: Tailwind scale; gap over margin.
  Breakpoints: Tailwind default sm, md, lg; column map in patterns.md.
  Layers: pending #1513.
  Motion: Tailwind transition default; keyframes in globals.css with reduced-motion fallbacks.
