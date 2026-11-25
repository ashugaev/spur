---
name: design-system
description: Spur web design system contract — tokens, recipes, primitives, patterns, contrast, versioning and migrations for packages/web. Use when adding, changing or reviewing a token, color, recipe, component variant or cross-screen pattern, or when planning a design-system phase. Don't use for non-visual web logic.
---

DESIGN SYSTEM

Contract for packages/web visuals. Repo wins over any canvas, screenshot or spec.

SOURCE

  packages/web/src/app/globals.css                   tokens; @theme = dark default, :root[data-theme="light"] = light
  packages/web/src/design/colors.ts                  hex mirrors for TS-only consumers: metadata, xterm
  packages/web/src/design/classes.ts                 recipes, one constant per variant
  packages/web/src/design/registry.json              DS version, token and recipe status          P0
  packages/web/src/design/migrations/<semver>.md     one file per DS version                      P0
  packages/web/src/__tests__/design-system.test.ts   guard                                        P0
  packages/web/public/spur/spur-page-theme.v2.css    public page palette, versioned by file name

  P0 marks a file absent until phase P0 merges. Check it exists before use.
  File shapes: references/versioning.md. Never invent another shape.

STATE

  DS version: registry.json version. Before P0: unversioned baseline, treat as 1.0.0.
  Phase status: references/roadmap.md. Planned tokens and recipes stay unusable until their phase merges.
  Usable names: grep globals.css and classes.ts. A name in references/ only is a plan, not an API.

RULES

  - Color: var(--color-*) only. Literals (hex, rgb, hsl, Tailwind palette and white/N, black/N) live in theme blocks and colors.ts, nowhere else.
  - TS without CSS vars (metadata, xterm): import from @/design/colors. New color: token in globals.css first, then export.
  - New color token: both theme blocks, registry entry, contrast rule, one commit.
  - Radius 0. Status dots alone take a full radius.
  - One family via --font-sans. Body size and tracking inherit from body; never restate.
  - Labels, headers, buttons, stats: uppercase class. Source copy stays sentence case.
  - Status: component props take a tone (error, attention, working, ready, inactive), never a color. Map: references/patterns.md.
  - Recipes: compose classes.ts constants with layout utilities. Never copy a recipe string. New variant extends the recipe.
  - Primitive exists: use it. List: references/components.md.
  - Focus: focus-visible 1px solid accent on every control.
  - Disabled: disabled attribute plus opacity 0.5. Never a muted color instead.
  - Shadow: heaviest allowed 0 20px 60px modal. No gradients, no emoji glyphs.
  - Contrast: references/contrast.md. Text 4.5:1 at every size, control edges and glyphs 3:1, worst stacked surface, both themes.

CHANGE

  1  Classify bump: references/versioning.md SEMVER.
  2  Visible change: run `design` approval before implementation.
  3  Edit globals.css both themes, classes.ts, or the primitive.
  4  Registry: add, deprecate or remove entry; bump version.        P0+
  5  Write migrations/<version>.md.                                  P0+
  6  Rename: alias old to new and deprecate. Remove only in next major.
  7  Migrate callsites by hand, one file at a time. `rg` the old name first.
  8  Run named tests: design-system.test.ts, snippet-tokens.test.ts, touched component tests.
  9  Phase merged: update references/roadmap.md status and the reference it changed.
  10 PR body states DS version before -> after.

REVIEW

  designer and reviewer fail a diff on: literal color, copied recipe string, raw color prop on a tone component, missing focus-visible, deprecated name past removeIn, contrast under rule.

REFERENCES

  references/tokens.md      token groups, roles, planned scales
  references/components.md  primitives, owners, variants, consolidation targets
  references/patterns.md    status map, zones, responsive columns, states, copy, voice
  references/contrast.md    guidelines C1-C10, audit, fix values
  references/versioning.md  semver, lifecycle, registry and migration shapes, guard checks
  references/roadmap.md     phases P0-P6, simplifications, status
