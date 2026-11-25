PATTERNS

Cross-component rules. Breaking one needs `design` approval.


STATUS

  One map from domain state to tone, in code. Components take the tone.

  State maps and lane order: ActivityDot.tsx and ATTENTION_LANE_META in lib/types.ts.
  Empty zone: not rendered.
  Unknown state falls to inactive, never error.
  Tone never alone: dot plus label, chip text, or zone header.
  Tone access: design/tone.ts. Never map colors inside consumers.


SESSION LIST

  Compose Zone.tsx and DataRow.tsx; preserve branch/project/metadata hierarchy.


RESPONSIVE COLUMNS

  Column visibility: SessionRow.tsx and Dashboard.tsx.
  Preserve primary session identity and actions on narrow screens.


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
