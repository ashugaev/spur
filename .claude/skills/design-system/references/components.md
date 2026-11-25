COMPONENTS

Owner file per primitive. Screens compose; never restyle internals.


RECIPES, design/classes.ts

  PRIMARY_BUTTON_CLASS     accent fill, text-inverse label
  SECONDARY_BUTTON_CLASS   structural edge, secondary text
  DANGER_BUTTON_CLASS      error edge and text; hover error fill
  ATTENTION_BUTTON_CLASS   attention edge and text; hover attention fill
  INPUT_CLASS              input-bg, input-border, accent edge on focus
  CHECKBOX_CLASS           accent-color, focus ring offset 2
  FOCUS_RING_CLASS         accent outline on focus-visible
  ICON_BUTTON_CLASS        square icon-only button; caller sets size and idle text
  STATUS_CARD_CLASS        elevated card, shadow-raised
  HARD_WRAP_TEXT_CLASS     long unbroken text
  DATA_ROW_CLASS           DataRow.tsx; flat row, border-b subtle, hover overlay
  CHIP_CLASS               lib/tag-style.ts; tag chip shape, color from tagChipStyle


TONE, design/tone.ts

  StatusTone               working | ready | attention | error | inactive
  toneColor, toneBg, toneBorder   var() refs for dot, tint, edge


PRIMITIVES, components/

  ActivityDot        activity -> tone map, label; working pulses
  Zone               tone prop ("accent" for non-status sections): dot, caps label, tone rule, count
  DataRow            row shell + RowIconButton
  StatusCard         raised card; BlockingOverlayShell wraps it full screen
  Toast              success surface / error base, ICON_BUTTON_CLASS dismiss
  IconActionButton   ICON_BUTTON_CLASS, icon as child, busy label
  IconCloseButton    ICON_BUTTON_CLASS + CloseIcon
  EmptyState         dashed surface box, BrandGlyph, one sentence
  LoadingBar         2px sweep, role status, aria-label
  Skeleton           list placeholder sweep
  CenteredLoader     five-cell mark, full panel
  icons/Spinner      voice transcription only
  StatusBar          stats row: icon, label, bold value, tone when over threshold


ADDING A PRIMITIVE

  1  Two or more callers with the same recipe. One caller: keep it local.
  2  Owner file in components/ or recipe in classes.ts. Props: tone, size, variant as unions.
  3  Registry recipe entry when classes.ts gains an export; minor bump; migration file.
  4  Migrate existing duplicates in the same change or list them in roadmap.md.

  Consolidation targets: roadmap.md NEXT P4.
