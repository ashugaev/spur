---
name: design-system
description: Spur web design system contract — tokens, recipes, primitives, patterns, contrast, versioning and migrations for packages/web. Use when adding, changing or reviewing a token, color, recipe, component variant or cross-screen pattern, when the user gives design feedback, or when planning design-system work. Don't use for non-visual web logic.
---

DESIGN SYSTEM

Contract for packages/web visuals. Code wins over any canvas, screenshot or spec. References name tokens and files; values live only in code.

SOURCE

  packages/web/src/design/tokens.css                 every token; first block dark/default, second block light
  packages/web/src/design/registry.json              DS version, token groups, contrast rules, recipes, literal allowlist
  packages/web/src/design/classes.ts                 recipes, one constant per variant
  packages/web/src/design/tone.ts                    StatusTone and tone var() helpers
  packages/web/src/design/colors.ts                  hex mirrors for TS-only consumers: metadata, xterm
  packages/web/src/design/migrations/<semver>.md     one file per DS version
  packages/web/src/__tests__/design-system.test.ts   guard
  packages/web/src/app/globals.css                   imports tokens.css; base element styles, keyframes
  packages/web/public/spur/spur-page-theme.v2.css    public page palette, versioned by file name

STATE

  DS version: registry.json version. Phase status: references/roadmap.md.
  Usable names: tokens.css and classes.ts. A name only in references/ is a plan, not an API.

RULES

  - Color: var(--color-*) only. Literals (hex, rgb, hsl, Tailwind palette, white/N, black/N) live in tokens.css and colors.ts. Exceptions: registry.json literalAllow, with reason.
  - TS without CSS vars (metadata, xterm): import from @/design/colors. New color: token in tokens.css first, then export.
  - New color token: follow references/tokens.md placement; registry entry and text/field contrast rule in same commit.
  - Scales only: text-*, tracking-*, shadow-*, rounded-dot. Names: references/tokens.md. Arbitrary values fail the guard.
  - Square corners. rounded-dot for status dots only.
  - One family via --font-sans. Body size and tracking inherit from body in globals.css; never restate.
  - Labels, headers, buttons, stats: uppercase class. Source copy stays sentence case.
  - Status: component props take a StatusTone (design/tone.ts), never a color. State maps: ActivityDot.tsx and lib/types.ts.
  - Recipes: compose classes.ts constants with layout utilities. Never copy a recipe string. New variant extends the recipe.
  - Icon-only button: ICON_BUTTON_CLASS plus size and idle text color.
  - Focus: FOCUS_RING_CLASS on every control without a recipe carrying it.
  - Disabled: disabled attribute plus opacity 0.5. Never a muted color instead.
  - No gradients, no emoji glyphs.
  - Contrast: references/contrast.md.

CHANGE

  1  Classify bump: references/versioning.md SEMVER.
  2  Visible change: run `design` approval before implementation.
  3  Edit owning source; token placement: references/tokens.md.
  4  registry.json: add, deprecate or remove entry; bump version.
  5  Write migrations/<version>.md: names and intent, never values.
  6  Rename: alias old to new and deprecate. Remove only in next major.
  7  Migrate callsites by hand, one file at a time. `rg` the old name first.
  8  Run named tests: design-system.test.ts, snippet-protocol.test.ts, snippet-tokens.test.ts, touched component tests.
  9  Phase merged: update references/roadmap.md status.
  10 PR body states DS version before -> after.

REVIEW

  designer and reviewer fail a diff on any references/errors.md entry the diff adds. Guard entries fail CI first.

LEARN

User design feedback evolves the rules. Run on every correction, rejection or stated preference about visuals, tokens or design process.

  1  Fix the instance the feedback names.
  2  Classify: one-off taste for this screen, or a rule that applies beyond it. Repeated or general wording ("always", "never", "everywhere", "again") is a rule.
  3  Rule: edit the owning file (tokens, patterns, contrast, components, errors, versioning). Contradiction: replace the old rule, never stack both.
  4  Append one line to references/decisions.md: date, feedback, rule, file.
  5  Regex-detectable without false positives: add a registry banned pattern; otherwise an errors.md review entry.
  6  Token or recipe change: normal CHANGE procedure, version bump.
  7  Mirror .agents and .claude in the same commit; PR body lists rule changes.
  8  Heavy follow-up out of scope: GitHub issue linked from #1518 and roadmap.md.

  Before designing, read decisions.md newest-first; a logged decision overrides a default in this skill.

REFERENCES

  references/tokens.md      placement, naming, adding a token
  references/components.md  recipes, tone helpers, primitives
  references/patterns.md    status map, zones, responsive columns, states, copy, voice
  references/contrast.md    guidelines C1-C9
  references/errors.md      typical design errors, guard or review
  references/decisions.md   user feedback log, newest last
  references/versioning.md  semver, lifecycle, migration format
  references/roadmap.md     version status, follow-up issues
