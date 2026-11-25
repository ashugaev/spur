CONTRAST

WCAG 2.2 AA, both themes. Rules per token: registry.json contrast. Check: design-system.test.ts. `design` skill measures rendered pixels.


GUIDELINES

  C1  Text 4.5:1 at every size. Body and label sizes never qualify as large text.
  C2  Worst stacked surface counts: every registry surface, alone and under every registry overlay. Translucent tokens composite over their real ground first.
  C3  Field edge 3:1 via --color-input-border: the edge is the field's only cue. Buttons are identified by label or glyph; their edges stay structural (subtle, default, strong).
  C4  Status words use the status token itself; every status token carries a 4.5 rule. A tint (status-<tone>-bg) is ground, never text.
  C5  Solid fills carry labels in --color-bg-elevated or --color-text-inverse; the pair needs 4.5:1 in both themes.
  C6  Opacity never makes a text color. opacity 0.5 means disabled; disabled text is exempt.
  C7  Color never the only signal: word, glyph or position beside every tone. Tones differ in lightness, not hue alone.
  C8  Focus ring: FOCUS_RING_CLASS, accent outline, 3:1 against every surface.
  C9  Fix by changing the token value, never by a per-component override.


ADDING A RULE

  Token used as text or as a field edge: add contrast to its registry entry in the same commit. Test fails until both themes pass.
