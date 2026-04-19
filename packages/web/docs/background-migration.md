# Background migration: `#0d0d0e` → `#27272a` (zinc-800)

Snapshot analysis only. No component code has been modified. Palette inventory
lives in `packages/web/src/design/colors.ts`.

## Current state

The palette is centralized in `packages/web/src/app/globals.css` under the
Tailwind v4 `@theme { … }` block. There is no `tailwind.config.*`. Semantic
tokens flow into components via `bg-[var(--color-bg-…)]`, `text-[var(--color-text-…)]`
and similar arbitrary classes. A few surfaces and every favicon bypass the
tokens and use raw literals.

Key facts:

- Body base: `var(--color-bg-base)` = `#0d0d0e`.
- Primary text: `--color-text-primary` = `#e1e1e1` (not pure white).
- Accent (white on dark): `--color-accent` = `#ffffff`, with `--color-text-inverse`
  (`#0d0d0e`, identical to base) used as text on white chips/buttons.
- Inputs/textareas share one recipe across all seven inputs:
  `bg-[var(--color-bg-surface)]` (`rgba(17,17,18,0.8)`) +
  `text-[var(--color-text-primary)]` + `border-[var(--color-border-default)]` +
  placeholder via global `--color-text-tertiary`.

## 1. Surfaces that must co-move with the base

Changing just `--color-bg-base` to `#27272a` is not enough — several paired
tokens are tuned to sit *on* the current near-black base and will collapse
visually against zinc-800 unless they also move.

| Token / literal | Current | Needs to become | Why |
|---|---|---|---|
| `--color-bg-surface` | `rgba(17,17,18,0.8)` | `rgba(58,58,62,0.85)` ≈ zinc-700 over base | Inputs/cards currently rely on a *subtler* gray than the base. On `#27272a` this resolves to ~`#242428`, i.e. darker than the body, which inverts the intended hierarchy. Surface must become lighter than base. |
| `--color-bg-elevated` | `rgba(23,23,26,0.9)` | ~`rgba(70,70,76,0.92)` ≈ zinc-600 tone | Popovers/StatusBar menus should read as "above" the surface. |
| `--color-border-subtle` / `default` / `strong` | rgbas of `35,35,38` / `50,50,54` | Step one or two zinc tiers lighter (e.g. `rgba(63,63,70,…)` → `rgba(82,82,91,…)` → `rgba(113,113,122,…)` = zinc-700 → 600 → 500) | Borders currently read at ~2–5% luminance above base; on zinc-800 they effectively disappear. |
| `bg-white/5` hover (15 sites) | 5% white on `#0d0d0e` ⇒ effective luminance ~`#181818` | Bump to `bg-white/6`–`white/8` on zinc-800 | At 5% opacity over `#27272a` the lift is barely visible. |
| `bg-black/60`, `bg-black/70` modal backdrops | Pure black at 60/70% | Keep `black` but likely drop to `/50`–`/60` range | Heavy backdrops against a lighter body feel crushing; verify during migration. |
| Shadow presets (`0 20px 60px rgba(0,0,0,0.5)` etc.) | Black at 30–50% | Consider `rgba(0,0,0,0.6+)` or push toward `rgba(0,0,0,0.7)` for Dashboard modal | Ambient shadows rely on the body being near-black. On zinc-800 they read as a mid-gray halo. |
| `.data-row:hover` `rgba(255,255,255,0.03)` | 3% white on near-black | Needs ~6–8% to remain perceptible | Same reason as `bg-white/5`. |
| Scrollbar thumb (`rgba(255,255,255,0.08/0.15/0.25)`) | White over near-black | Stays functional but contrast drops; consider 0.10/0.18/0.28 | Low-priority but visible on hover. |
| `--color-text-inverse` = `#0d0d0e` | Matches old base by design | Should track the new base → `#27272a` | This is the text color *on* white accent chips/buttons. If it stays `#0d0d0e`, accent chips keep dark text that does not match the new body, which is fine functionally but conceptually stale. |

## 2. Inputs — lighter, closer to white

Today every input inherits `--color-bg-surface` (`rgba(17,17,18,0.8)`), so on
the current page they read almost identical to the body. The brief asks for
inputs that read as *lighter, closer to white* on the new base.

Recommended recipe on `#27272a` base:

| Property | Suggested value | Notes |
|---|---|---|
| Background | `#f4f4f5` (zinc-100) | Closest to "white" without being the pure `#ffffff` reserved for accent buttons. |
| Text | `#18181b` (zinc-900) | Contrast ratio on zinc-100 ≈ **16 : 1** (AAA). |
| Placeholder | `#71717a` (zinc-500) | Contrast on zinc-100 ≈ 4.6 : 1 — meets AA for normal text and clearly reads as muted. |
| Border (idle) | `#d4d4d8` (zinc-300) | Keeps the field shape visible on the dark body without competing with the accent focus ring. |
| Border (focus) | Current `--color-accent` = `#ffffff` still works against a light field — but flipping to `--color-accent-violet` (`#a371f7`) would read more clearly as an active state. Open choice. |
| Caret | `color: #18181b` via CSS (ensure `caret-color` not overridden) | Needed because xterm overrides caret on its own textarea (rule keyed on `.xterm-helper-textarea`). |

Alternative (less drastic) if full inversion feels too jarring:
`bg: #e4e4e7` (zinc-200) + `text: #27272a` + `border: #a1a1aa` (zinc-400).
Contrast stays AAA (~14 : 1) but the fields are less bright.

Affected components: 7 inputs across `Dashboard.tsx`, `SessionDetail.tsx`,
`VoiceInput.tsx`, plus the global `::placeholder` rule in `globals.css`.

## 3. Primary white text — more muted gray

Current `--color-text-primary` is **`#e1e1e1`**, not pure white. On the new
base:

| Candidate | Hex | Contrast vs `#27272a` | Comment |
|---|---|---|---|
| Current | `#e1e1e1` | ~11 : 1 | Still AAA. No change needed functionally. |
| **Recommended** | **`#d4d4d8` (zinc-300)** | ~9.6 : 1 | Drops perceived brightness one notch while staying AAA. Feels softer on a lighter body. |
| More muted | `#a1a1a1` ≈ `--color-text-secondary` today | ~5.7 : 1 | Meets AA for normal text but too soft for default body copy — already used for secondary labels. |

Keep `--color-text-secondary` (`#a1a1a1`) and `--color-text-tertiary` (`#555558`)
as-is for now; both still clear AA on the new base.

Note `--color-accent: #ffffff` is the *interactive white* (links, primary
buttons). It should stay pure white — the change is only to the primary body
text.

## 4. Scope estimate

Roughly **20 files** need visual review, grouped by how they'll be touched:

| Tier | Count | Files | Nature of change |
|---|---|---|---|
| Central (token edits only) | 1 | `src/app/globals.css` | Update `@theme` vars + scrollbar / data-row / activity-pulse rgba. This alone shifts the largest number of call sites. |
| Hardcoded hex siblings | 6 | `app/manifest.ts`, `app/layout.tsx`, `app/apple-icon.tsx`, `app/icon.tsx`, `app/icon-192/route.ts`, `app/icon-512/route.ts` | Swap `#0D0D0E` → `#27272a`. Plus 1 test fixture in `__tests__/components.test.tsx`. |
| Component overlays and chips | 9 | `Dashboard.tsx`, `SessionDetail.tsx`, `DirectTerminal.tsx`, `VoiceInput.tsx`, `InputHistory.tsx`, `StatusBar.tsx`, `SessionRow.tsx`, `ActivityDot.tsx`, `TerminalModal.tsx` | Bump `bg-white/5`, recalibrate shadows, verify chip bg/border contrast. |
| Inputs | 3 | `Dashboard.tsx`, `SessionDetail.tsx`, `VoiceInput.tsx` (overlap with above) | Apply the new light-input recipe from §2. Consider extracting a new `--color-input-bg` / `--color-input-text` token pair rather than rewriting every input inline. |
| Out-of-palette surfaces | 1 | `DirectTerminal.tsx` (xterm `#0a0a0f`) | Decide: keep terminal darker for authenticity, or retint to sit on the new base. Lean *keep* — terminals historically stay near-black. |

The largest real write is almost certainly the `@theme` block; most components
pick up the change for free once `--color-bg-base`, `--color-bg-surface`,
`--color-bg-elevated` and the three border tiers move.

## 5. Risks

1. **Hardcoded `#0D0D0E` in manifest / icons.** Six app-shell files embed the
   base color. These are the favicon, apple-icon, PWA manifest, and the
   `<meta name="theme-color">` tag. Any migration that forgets them will leave
   a dark rim around the PWA install banner and splash screens.
2. **Test fixture assertion.** `src/__tests__/components.test.tsx:756-757`
   asserts `background_color: "#0D0D0E"` and `theme_color: "#0D0D0E"`. Must
   update in the same commit as the manifest change.
3. **Terminal theme drift.** `DirectTerminal.tsx` hardcodes the xterm `ITheme`
   (`#0a0a0f` background, full 16-color ANSI palette). These do *not* come
   from CSS vars and will not follow the base change. Decide explicitly
   whether the terminal should continue reading as a separate "deeper" surface
   or move with the body.
4. **Input recipe duplication.** Seven inputs repeat the same four classes.
   Migrating them cleanly probably means introducing `--color-input-bg` /
   `--color-input-text` / `--color-input-border` tokens instead of rewriting
   each site. Without that, the migration spreads across 7 files.
5. **`bg-white/5` as hover language.** 15 call sites use `bg-white/5` for the
   universal "interactive lift" state. At 5% opacity over `#27272a` the lift
   is barely visible (~1% luminance delta). Either bump the ratio globally or
   switch to a named token (`--color-hover-overlay`).
6. **Opacity-based surface tokens.** `--color-bg-surface` and
   `--color-bg-elevated` are `rgba(…, 0.8/0.9)` — they *mix with the body*.
   Changing the body shifts the rendered surface color even if the token is
   untouched. This is subtle and makes visual QA mandatory on every surface
   using these tokens (19 + 6 sites).
7. **`color-mix()` borders.** `ActivityDot.tsx:69` and `AttentionZone.tsx:41`
   composite `var(--color-border-default)` / status colors with `transparent`
   at 85% / 25%. The borders will visibly change once the border tokens shift
   — not a bug, but worth confirming in a design pass.
8. **Shadow legibility.** Five `shadow-[0_…_rgba(0,0,0,0.3-0.5)]` presets
   were tuned for near-black. On zinc-800 they read as a mid-gray halo rather
   than a soft drop shadow; expect to bump the alpha.
9. **No external UI library** (MUI / Chakra / etc.) in `packages/web` — so no
   third-party theme provider to reconfigure. The only non-first-party visual
   surface is `xterm`, covered in risk 3.
10. **No `tailwind.config.*`** anywhere in the repo. All theme edits happen in
    `globals.css`. Safe, but worth noting because tutorials and code-style
    references assume a config file.

## Suggested migration shape (not part of this PR)

1. Add `--color-input-bg` / `--color-input-text` / `--color-input-border`
   tokens to `@theme`, migrate the seven inputs to them — *before* touching
   the base. This lets the input pass land independently.
2. Update the hardcoded `#0D0D0E` sites + the manifest test fixture in one
   commit. No visual change on prod yet because the body still equals
   `#0d0d0e`.
3. Swap `--color-bg-base` → `#27272a`, retune `--color-bg-surface`,
   `--color-bg-elevated`, the three border tiers, and the rgba overlays in
   `globals.css`. One PR, one reviewer pass, one visual QA pass.
4. Follow-up: raise `bg-white/5` → a named `--color-hover-overlay` token and
   decide terminal-background policy.
