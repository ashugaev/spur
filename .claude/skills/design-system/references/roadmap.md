ROADMAP

Phases ship in order, each through manager gates. Update STATUS when a phase merges.


STATUS

  P0  planned
  P1  planned
  P2  planned
  P3  planned
  P4  planned
  P5  planned
  P6  planned


PHASES

  P0  1.0.0  contract, no visual change, 1 PR
      registry.json from current globals.css, migrations/1.0.0.md, guard G1 G2 G3 G4 G7.
  P1  1.1.0  contrast and focus, approval, 1 PR
      fix values in contrast.md, --color-border-control on INPUT_CLASS, SECONDARY_BUTTON_CLASS, icon buttons, focus-visible on IconActionButton, IconCloseButton, RowIconButton, TerminalIconButton, toast dismiss; attention hover tint; guard G5.
  P2  1.2.0  scales, approval for folds, 3-4 PRs by directory
      tokens.md SCALES into @theme; migrate text-[Npx], tracking-[..], shadow-[..], z-[..], h-N w-N icon and control sizes; rounded-full on dots -> rounded-dot.
  P3  1.3.0  tone set, approval, 2 PRs
      status tone and -text tokens, color-mix -bg and -border, CHIP_CLASS, Banner, typed ActivityDot map, Zone tone prop; deprecate chip-*, dot-bg-*, input-*, row-hover.
  P4  1.4.0  primitives, 4-5 PRs of 4-5 files
      IconButton, Dialog, Menu, Popover; migrate 18 dialog shells and 5 icon buttons.
  P5  1.5.0  icons, 2 PRs
      icons/ registry plus Icon size prop; move 78 inline svg from 17 files.
  P6  2.0.0  cut, 1 PR
      remove deprecated aliases; guard G6 bans arbitrary size, tracking, shadow, z, rounded-* except rounded-dot; G8; spur-page-theme.v3.css maps --spur-* onto --color-*.


SIMPLIFICATIONS

  --color-input-*          -4   bg-surface, text-primary, border-control, text-tertiary
  --color-row-hover        -1   hover-overlay
  status 4 + chip 6 + dot 5 -> 5 tone + 5 text; bg and border derived once
  shadow colors            private inputs to 3 elevation tokens
  icon buttons             5 -> IconButton
  dialog shells            18 -> Dialog
  banners                  3 -> Banner
  inline svg               78 -> icons/
  page palette             own hexes -> aliases of --color-*
  skills                   frontend-codestyle keeps code, copy, validation; this skill owns visuals

  End state 2.0.0: color values per theme 43 -> 34, font sizes 14 -> 5, tracking 8 -> 5, shadows 5 -> 3, z 11 -> 7, AA failures 28 -> 0.


OUT OF SCOPE

  Dashboard.tsx over 3000 lines holds FAB and header patterns. File an issue; extract when P4 touches them.
