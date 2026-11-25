CONTRAST

WCAG 2.2 AA, both themes. `design` skill measures rendered pixels; this file owns token rules.


GUIDELINES

  C1   Text 4.5:1 at every size. Body 12px and labels 10px never qualify as large text.
  C2   Measure the worst stacked surface: base, surface, elevated, each plus hover overlay. Composite rgba over its real background first.
  C3   Graphic role (--color-status-<tone>: dot, icon, edge) needs 3:1. Words in a tone use the -text role, 4.5:1 on base and on the tone's own -bg.
  C4   Control boundaries 3:1: inputs, secondary buttons, icon buttons use --color-border-control. subtle, default, strong stay structural and exempt.
  C5   Solid fills: accent and error only, label --color-text-inverse. Attention never fills solid; hover takes its tint and keeps -text.
  C6   Opacity never makes a text color. opacity 0.5 means disabled only; disabled text is exempt.
  C7   Color never the only signal: word, glyph or position beside every tone. Tones differ in lightness, not hue alone.
  C8   New color token ships both themes plus its registry contrast rule in one commit.
  C9   Focus ring: 1px solid accent, 3:1 against every surface both themes.
  C10  Fix by changing the token value, never by a per-component override.


AUDIT, main 2026-11-25

  28 token x surface pairs failed: 17 light, 11 dark.

  dark   text-tertiary, input-placeholder 2.14 worst
  dark   control edges (input-border, border-strong) 1.01-1.24
  light  text-tertiary, input-placeholder 2.97
  light  status-attention as text 2.70, as dot on hover 2.70
  light  accent link on hover surface 4.46
  light  accent-violet 4.34
  light  ready and working words on hover 4.37 / 4.46
  light  attention hover label on solid fill 3.14
  light  control edges 1.23-1.58


FIX VALUES, P1

Worst-surface ratio after fix in brackets. Values move to globals.css in P1, then this list is deleted.

  dark   --color-text-tertiary           #555558 -> #8b8b90   [4.68]
  dark   --color-input-placeholder       #555558 -> #8b8b90   [4.68]
  dark   --color-border-control  new                 #74747b   [3.42]
  dark   --color-input-border            -> #74747b           [3.42]
  light  --color-text-tertiary           #818b98 -> #656d76   [4.51]
  light  --color-input-placeholder       #818b98 -> #656d76   [4.51]
  light  --color-accent                  #0969da -> #0860ca   [5.11]
  light  --color-accent-hover            #0860ca -> #0550ae   [6.53]
  light  --color-accent-violet           #8250df -> #6639ba   [6.31]
  light  --color-status-attention        #bf8700 -> #a87600   [3.43 graphic]
  light  --color-chip-warn-text, attention words  -> #8a5a00  [5.10]
  light  ready words                     #1a7f37 -> #116329   [6.36]
  light  working words                   #0969da -> #0860ca   [5.11]
  light  --color-border-control  new                 #768390   [3.33]
  light  --color-input-border            #d1d9e0 -> #768390   [3.33]

  Dark tertiary rises toward secondary (1.31:1 apart). Hierarchy keeps through size and weight; accepted.
  Attention button hover: tint, not fill, both themes.
