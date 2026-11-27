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


TARGET SIZES

  Every screen and component is designed and checked at required widths:
  phone        390      no side panels; context as chips plus bottom sheet; 44px tap targets
  iPad mini    744 and 1133 landscape   side panel collapsed, opens as overlay; 40px tap targets
  desktop      1440     full layout, side panel inline
  Same components at every size; only placement changes. A design missing one size is incomplete.


ICONS

  Reuse the repo icon component for any behavior that already has one: Dashboard lane icons, link-icons.tsx, components/icons/, DirectTerminal, VoiceInput.
  Designs copy that exact SVG; never redraw or approximate it.
  New icon only where no repo icon exists; mark it proposed and get design approval before it ships.
  Sprite: DS canvas board 09 Icons lists every repo icon with its source file, proposed icons, and the migration table.
  Every new icon enters the sprite as proposed. One that supersedes an existing icon names what it replaces and where, and adds a migration row.
  Target: one icon per meaning in components/icons/; merge duplicates through the migration table. Implementation: #1514.


VOICE INPUT

  Every free-text input carries the voice button (VoiceInput.tsx, useVoiceInput): composer, answers, notes, edits.
  Strict inputs skip it: search, filters, ids, numbers, paths, tag pickers.
  Control and state contract: VoiceInput.tsx and useVoiceInput.ts.
  Transcript inserts into target input without confirmation. Terminal: confirm popup before typing into tmux.
  Recording: error edge plus error tint on mic button. Transcribing: error spinner replaces mic glyph.


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
  Placeholders sentence case: "Filter".
  No trailing ellipsis ("..." or "…") on any visible text: placeholders, labels, menu items, statuses. Truncation ellipsis from CSS or truncateMiddle is fine.
