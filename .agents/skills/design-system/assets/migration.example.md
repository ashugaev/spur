VERSION 1.3.0  minor  2026-12-01

CHANGES

  add        --color-status-inactive
  add        --color-status-<tone>-text, -bg, -border
  add        CHIP_CLASS, Banner
  deprecate  --color-chip-error-bg      -> --color-status-error-bg
  deprecate  --color-chip-error-border  -> --color-status-error-border
  deprecate  --color-chip-error-text    -> --color-status-error-text
  deprecate  --color-dot-bg-waiting     -> --color-status-attention-bg
  removeIn   2.0.0

CALLSITES

  rg -l 'color-chip-|color-dot-bg-' packages/web/src
  Edit each file by hand: swap token, keep layout classes.
  Zone: color prop -> tone prop.

VERIFY

  pnpm --dir packages/web exec vitest run src/__tests__/design-system.test.ts
  design skill: screenshot changed rows, both themes
  APPROVAL  pending
