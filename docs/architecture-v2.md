# Spur Architecture Intent

This repository has one behavioral source of truth: `v2/`.

`packages/web/` is the only supported non-`v2` product surface, and it must stay a thin UI over Spur's daemon API.

## Supported Shape

- local HTTP daemon plus CLI in `v2/`
- optional web UI in `packages/web/`
- flat metadata plus event log under the configured Spur data directory
- `tmux` plus `git worktree` as the session runtime boundary
- built-in automation only through sources emitting events and triggers mapping them to `spawn` or `send`

## Explicitly Out of Scope

- legacy AO/v1 backends or config surfaces
- plugin registries or dynamic plugin loading in this repo
- separate web backend state machines
- mobile clients
- parallel docs/config examples that describe a different product

## Core Flow

```text
CLI -> ensure daemon -> session service
    -> create worktree or shared workspace
    -> launch agent in tmux
    -> persist session metadata
    -> expose state via daemon API
```

`list`, `send`, `pause`, `complete`, and `kill` all flow through the same daemon boundary.

## Web Boundary

The web package may:

- read the Spur daemon API
- proxy write actions to the Spur daemon API
- read a local Spur config for project labels or branding

The web package may not:

- become a second backend
- own session lifecycle logic
- reintroduce AO/v1 runtime behavior

## Migration Rule

When cleaning or extending the repo:

- change `v2/` for behavior
- change `packages/web/` only for UI or API-proxy needs
- delete stale root artifacts instead of keeping two paths alive
