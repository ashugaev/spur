PATTERNS

Cross-component rules. Breaking one needs `design` approval.


STATUS

  One map from domain state to tone, in code. Components take the tone.

  tone       order  states                                           dot
  error      1      needs_input, error, budget_limited               static
  attention  2      waiting, rate_limited, wake scheduled            static
  working    3      working, starting                                pulse
  ready      4      completed, CI passing, review approved           static
  inactive   5      closed, stopped, killed, unknown                 static

  Zone order follows tone order. Empty zone: not rendered.
  Unknown state falls to inactive, never error.
  Tone never alone: dot plus label, chip text, or zone header.
  Graphic role uses --color-status-<tone>; words use the -text role. Until P3: chip-* and status text per ActivityDot.


SESSION LIST

  Zone header: 8px tone dot, caps label, rule in tone at 25%, count tertiary.
  Row: DATA_ROW_CLASS, primary branch bold, project secondary, meta tertiary, actions right.


RESPONSIVE COLUMNS

  below sm   header stacks, project and agent columns hidden, stats wrap, status word hidden
  sm-md      project column, tracker and PR links show
  md-lg      agent column shows
  lg+        branch column, full layout

  Classes: hidden sm:inline, hidden md:inline, hidden lg:inline.


STATES

  hover      text one step up; icon buttons and menu items add hover overlay
  focus      focus-visible 1px solid accent
  open       aria-expanded, edge stays strong
  busy       aria-busy plus busyLabel; spinner or bar, never wait text (eslint no-visible-wait-text)
  disabled   disabled attribute, opacity 0.5, cursor not-allowed
  error      error edge, message below, aria-invalid plus aria-describedby

  Data views show loading, empty, error. Forms show disabled, error, focused. Actions show disabled, busy.


OVERLAYS

  Modal: backdrop, elevated surface, modal shadow, Esc closes.
  Menu, popover, hover card: strong edge, overlay shadow, popover layer.
  Toast: above modals. Blocking overlay: above toasts.


COPY

  Visible labels use spaces: "Needs Input", never NEEDS_INPUT.
  Buttons, labels, headers uppercase via class; source sentence case.
  Placeholders sentence case: "Filter...".


VOICE

  Transcript inserts into the target textarea, no confirm. Terminal: confirm popup before typing into tmux.
  Recording: error edge plus error tint on the mic button. Transcribing: error spinner replaces the mic glyph.
