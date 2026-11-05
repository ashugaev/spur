# Pages

> Scope: Spur pages — files, `page.yaml`, URL, live events. Store: [stores.md](stores.md). CLI: [commands.md#db-page](commands.md#db-page). Owner: `v2/src/pages.ts`.

A page is a static web app in `<dataDir>/pages/<id>/` with its own store `page:<id>`. The web UI serves it at `/p/<id>/`.

## Create

```sh
spur page create films --title Films
spur page path films        # edit files here
spur db page:films add items '{"title":"Dune"}'
```

- Id `^[a-z0-9][a-z0-9-]{0,39}$`. A page exists while its dir exists.
- Template `blank`: `index.html` listing collection `items`, plus `<spur-chat>`.

## Files

- `page.yaml`: `title` (1..120 chars), `icon` (optional), `agent.runtime` (`claude` default, `codex`, `cursor`, `opencode`), `agent.model` (optional).
- Any static file; no build step. Dot paths and `data.sqlite*` are never served. Responses are `no-store`.
- Load the SDK with `<script src="./_spur/sdk.js"></script>`.

## Live events

- One stream per open tab, `/p/<id>/_spur/events`: `change` (store write, `id` = change seq), `reset` (refetch), `reload` (page file changed), `agent` (page agent status).
- File edits reload every open tab.

## Security

- `/p/<id>/` is same-origin with the dashboard: page JS can call the dashboard API. Run only pages you trust.
