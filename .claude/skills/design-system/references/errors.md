DESIGN ERRORS

Recurring mistakes in packages/web. Guard: caught by design-system.test.ts. Review: designer and reviewer check by hand.


TOKENS AND VALUES

  E1   literal color in a component               guard literals          token from tokens.css
  E2   var(--color-*) naming no registry token    guard refs              registry name
  E3   arbitrary text size, tracking, shadow      guard banned            scale utility
  E4   rounded-* corners                          guard banned            square; rounded-dot for dots
  E5   opacity to mute active text                guard banned            one text token step down
  E6   semibold, light, black weights             guard banned            400, 500, 700
  E7   raw color prop on a tone component         review                  StatusTone
  E8   theme branch in a component (dark:, data-theme)   review         token with both theme values


CONTRAST AND STATE

  E9   tertiary or status text on a tint not measured    review          contrast rule in registry; measure in both themes
  E10  outline-none without focus-visible on the element or a focus-within container   review   FOCUS_RING_CLASS
  E11  disabled look without disabled attribute    review                 disabled attribute plus opacity-50
  E12  tone as the only signal                      review                 word or glyph beside the dot
  E13  icon-only button without aria-label          review                 aria-label; title alone fails
  E14  hit area under 24px                          review                 pad to 24x24


STRUCTURE

  E15  copied recipe string                         review, #1510           classes.ts constant
  E16  hand-built modal shell                       review, #1511           Dialog
  E17  per-file icon-button classes                 review, #1512           ICON_BUTTON_CLASS / IconButton
  E18  arbitrary z-index                            review, #1513           layer token
  E19  inline svg duplicated across files           review, #1514           icons/ registry
  E20  hand-built tone chip or banner               review, #1515           Chip / Banner


PROMOTING A REVIEW CHECK TO THE GUARD

  Pattern detectable by regex with no false positives in src: add to registry banned with its use text. Otherwise keep it here as review.
