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

Run from source without a global install: `node v2/dist/cli.js <cmd>` after `pnpm --dir v2 build`. `pnpm --dir v2 build` also restarts a running daemon when Spur config is discoverable — a normal CLI command auto-connects its discovered project config into the daemon; registration and pruning rules live in [config registry](docs/configuration.md#config-registry).

For a throwaway verification daemon instead of pointing `--config` at an ad hoc path with prod-shaped `port`/`dataDir`, use `scripts/spur-isolated-daemon.sh`. `isolated-daemon` and `isolated-ui` project sidecars start an isolated Spur daemon and the web UI against it; new isolated worktrees inherit the current `spur.yaml`, agent instructions, and `.env` via the config overlay plus symlinks, and `isolated-ui` uses its own Next `distDir` so its cache stays isolated from normal `packages/web` runs.

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

`pnpm --dir v2 test` runs fast (mocked, in-process); `pnpm --dir v2 test:runtime` runs runtime integration (CLI, tmux, worktree, process boundaries); `pnpm --dir v2 test:smoke` runs a real-agent smoke test against this repo (skips if tmux/binaries/auth are missing). Run `test:runtime` when touching CLI, daemon, transport, session lifecycle, worktree, or tmux; run `test:smoke` when touching agent launch or prompt delivery.

Tests allocate temp dirs under `TMPDIR` only, never under `~/.spur`. If an
older revision left fixture dirs behind, list/remove them with
`bash scripts/clean-test-temp-dirs.sh` (dry-run by default, `--delete` to remove).

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
