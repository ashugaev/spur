# Contributing

This repo accepts changes in three places only:

- `v2/` for Spur behavior
- `packages/web/` for the optional UI over Spur's API
- root docs/scripts/workflows that support those two surfaces

## Setup

```bash
bash scripts/setup.sh
```

Bootstrap details live in [SETUP.md](SETUP.md).

## PR Checks

Before opening or updating a PR:

```bash
pnpm build
pnpm test
pnpm test:integration
pnpm lint
pnpm typecheck
```

When agent launch or prompt delivery changes:

```bash
pnpm --dir v2 test:smoke
```

## Repo Rules

- `v2/` is the source of truth for runtime behavior.
- `packages/web/` must stay a thin UI over Spur's daemon API.
- Prefer deleting stale paths over keeping compatibility shims.
- Keep `AGENTS.md` and `CLAUDE.md` in sync.
- Keep mirrored files under `.agents/` and `.claude/` in sync.

## CLI design

- Human-first output by default; structured commands expose `--json`.
- Single theme object (`v2/src/cli-view.ts`): brand accent `#f04c4c` (ids, tiny loading frames), brand mark `𖤓` (help headers, section headers, spinner). State dot: green `working`, yellow `waiting`/`needs_input`/`rate_limited`, accent-red `error`, gray everything else. `needs_input` renders as a bold yellow `!`, not a dot.
- Visual primitives: accent, bold, dim, whitespace. No box drawing, no rainbow status, no decorative state aliases.
- `@clack/prompts` only for transient UI (spinner, cancel, log, text); data rendering stays custom and flat — `list` is the reference renderer.
- `list` in the TTY live selector renders a dim column header (`id state project agent branch`) plus one padded row per session and a details pane for the selected session. Non-TTY prints a two-line card per session (primary row, dim secondary line), no header. Keys live in [docs/commands.md](docs/commands.md).
- `list` is the only session UI. TTY opens the live selector; non-TTY prints a one-shot summary.
- Never silently retarget keys after refresh — if the selected id disappears, require explicit reselection.
- Empty states: one sentence plus one dim next-step hint.
- Animation: at most a one-line transient spinner during waits, cleared before final output.

## Change Shape

- Keep PRs focused.
- Add or update tests when behavior changes.
- Update docs only where they remain the single source of truth.
- Use conventional commits (see `AGENTS.md` commit rules). Merges to `main` drive `@shugaev/spur` version via semantic-release.
