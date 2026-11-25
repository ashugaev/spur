ROADMAP

Phases ship in order, each through manager gates. Update STATUS when a phase merges.


STATUS

  P0  1.0.0  done      tokens.css, registry.json, guard
  P1  1.1.0  done      AA token values, ICON_BUTTON_CLASS, FOCUS_RING_CLASS
  P2  2.0.0  done      text, tracking, elevation scales; rounded-dot
  P3  2.0.0  done      tone set, design/tone.ts, Zone and lane meta on tones; chip-*, dot-bg-*, input-text, input-placeholder, row-hover removed
  P6  2.0.0  done      guard bans arbitrary size, tracking, shadow, rounded-*
  P4  2.1.0  planned   primitives
  P5  2.2.0  planned   icons
  P7  2.3.0  planned   layers


NEXT

  P4  IconButton on ICON_BUTTON_CLASS with size prop (absorbs IconActionButton, IconCloseButton, RowIconButton, TerminalIconButton); Dialog shell for the files using --color-modal-backdrop (native dialog, Esc, focus trap); Menu; Popover; CHIP_CLASS with tone; Banner for AuthAlertsBanner, SubmitFailedBanner, PendingLaunchBanner. Behavior change: browser proof per dialog.
  P5  icons/ registry plus Icon size prop; move inline svg out of components.
  P7  z-index tokens by role (raised, sticky, popover, modal, modal-stack, toast, blocking); audit stacking per overlay before folding values.
  P8  page palette v3: spur-page-theme.v3.css maps --spur-* onto --color-*; v2 stays served.


OUT OF SCOPE

  Dashboard.tsx holds FAB and header patterns over 3000 lines. File an issue; extract when P4 touches them.
