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
- Load the SDK with `<script src="./_spur/sdk.js"></script>`. API: [spur-sdk.md](spur-sdk.md).

## Live events

- One stream per open tab, `/p/<id>/_spur/events`: `change` (store write, `id` = change seq), `reset` (refetch), `reload` (page file changed), `agent` (page agent status).
- Resume: `since=<seq>` or `Last-Event-ID`. 64 open streams per daemon, then `503`.

## Page agent

- One background session per page, project `spur-page-<id>`, session ids `pg-<id>-<4 hex>`, cwd = page dir, runtime and model from `page.yaml`. Spawned on the first chat message or action; later messages are queued sends.
- Stopped or errored agent: resumed on the next message, no restore prompt; when resume fails, relaunched with its spawn prompt.
- Completed, killed or gone agent: a fresh session is spawned with its spawn prompt and bound.
- Budgets below persist in the page store.
- Automated messages (no user click): 10, reset by a user click. Over: `429`.
- User messages: 30 per 10 minutes. Over: `429`.
- Recoveries: 3, reset when the agent replies or the user clicks. Over: `503`.
- `spur page rm <id>` kills the page agent, closes open tabs' streams, deletes the dir.
- Status values: [spur-sdk.md](spur-sdk.md#api) `agent.status()`.

## Security

- `/p/<id>/` is same-origin with the dashboard: page JS can call the dashboard API. Run only pages you trust.
