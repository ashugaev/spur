# Contributing

This repo accepts changes in three places only:

- `v2/` for Spur behavior
- `packages/web/` for the optional UI over Spur's API
- root docs/scripts/workflows that support those two surfaces

## Setup

```bash
bash scripts/setup.sh
```

## Required Checks

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

## Change Shape

- Keep PRs focused.
- Add or update tests when behavior changes.
- Update docs only where they remain the single source of truth.
- Use conventional commits.
