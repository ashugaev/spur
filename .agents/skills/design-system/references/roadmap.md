ROADMAP

Tracking issue: #1518. Update STATUS when a phase merges.


STATUS

  1.0.0  done   tokens.css, registry.json, guard
  1.1.0  done   AA token values, ICON_BUTTON_CLASS, FOCUS_RING_CLASS
  2.0.0  done   text, tracking, elevation scales; rounded-dot; tone set; chip-*, dot-bg-*, input-text, input-placeholder, row-hover removed
  2.1.0  done   registry roles for every token; opacity and weight bans


NEXT, in order

  #1517  visual regression baseline, both themes
  #1510  button recipes with size axis
  #1512  IconButton
  #1511  Dialog primitive (extends #956)
  #1515  Chip and Banner on the tone set
  #1513  layer tokens for z-index
  #1514  icon registry
  #1516  page palette v3


OUT OF SCOPE

  Dashboard.tsx holds FAB and header patterns over 3000 lines; extract when #1510 or #1511 touches them.
