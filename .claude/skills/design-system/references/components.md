COMPONENTS

Owner file per primitive. Screens compose; never restyle internals. Planned rows unusable until their phase merges.


RECIPES, classes.ts

  PRIMARY_BUTTON_CLASS     accent fill, text-inverse label
  SECONDARY_BUTTON_CLASS   edge + secondary text; P1 edge -> border-control
  DANGER_BUTTON_CLASS      error edge and text; hover error fill, label text-inverse
  ATTENTION_BUTTON_CLASS   attention edge and text; P1 hover -> attention tint, never solid fill
  INPUT_CLASS              surface, edge, accent edge on focus; P1 edge -> border-control
  CHECKBOX_CLASS           accent-color, focus ring offset 2
  STATUS_CARD_CLASS        elevated card, raised shadow
  HARD_WRAP_TEXT_CLASS     long unbroken text
  DATA_ROW_CLASS           DataRow.tsx; flat row, border-b subtle, hover overlay

  Planned
  ICON_BUTTON_CLASS + size md|sm|xs|2xs    P4
  CHIP_CLASS + tone                        P3
  MENU_CLASS, MENU_ITEM_CLASS              P4
  POPOVER_CLASS                            P4


PRIMITIVES, components/

  ActivityDot        activity -> tone, label; working pulses        P3: typed union key, tone map
  Zone               tone dot + caps label + tone rule + count      P3: tone prop replaces color
  DataRow            row shell + RowIconButton
  StatusCard         raised card; BlockingOverlayShell wraps at z 100
  Toast              success surface / error base, dismiss button
  EmptyState         dashed surface box, BrandGlyph, one sentence
  LoadingBar         2px sweep, role status, aria-label
  Skeleton           list placeholder sweep
  CenteredLoader     five-cell mark, full panel
  icons/Spinner      voice transcription only
  StatusBar          stats row: icon 16, label, bold value, tone when over threshold


CONSOLIDATION TARGETS

  IconButton    P4   replaces IconActionButton, IconCloseButton, RowIconButton, TerminalIconButton, toast dismiss
  Dialog        P4   one shell for 18 files using --color-modal-backdrop: native dialog + showModal, header caps title + md close, body p-4 gap, footer secondary then primary, Esc, focus trap
  Banner        P3   tone + text + one action; AuthAlertsBanner, SubmitFailedBanner, PendingLaunchBanner keep logic, render Banner
  Chip          P3   tone chip; replaces chip-* usage
  Menu          P4   border-strong, overlay shadow, item hover overlay
  Popover       P4   anchored panel, z-popover; wake and sidecar popovers in SessionRow
  Icon          P5   icons/ registry; 78 inline svg in 17 files move in, size by token


ADDING A PRIMITIVE

  1  Two or more callers with the same recipe. One caller: keep it local.
  2  Owner file in components/ or recipe in classes.ts. Props: tone, size, variant as unions.
  3  Registry entry, minor bump, migration file.
  4  Migrate existing duplicates in the same phase or list them in roadmap.md.
