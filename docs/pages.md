# Pages

> Scope: Spur pages — files, `page.yaml`, URL, live events. Store: [stores.md](stores.md). CLI: [commands.md#db-page](commands.md#db-page). Owner: `v2/src/pages.ts`.

A page is a static web app in `<dataDir>/pages/<id>/` with its own store `page:<id>`. The web UI serves it at `/p/<id>/`.

Open the project menu → Pages for the catalogue. Titles open pages in a new tab; Agents returns to the dashboard with the selected project. The catalogue lists readable, valid page configurations; it does not check the entry document.

CREATE PAGE opens a new placeholder with its agent chat. Creation errors preserve the catalogue; retry with the same button.

## Create

```sh
spur page create films --title Films
spur page path films        # edit files here
spur db page:films add items '{"title":"Dune"}'
```

- Id `^[a-z0-9][a-z0-9-]{0,39}$`. A page exists while its dir exists.
- Template `blank`: document symbol, title and placeholder. No AI call during creation.

## Files

- `page.yaml` fields: [configuration.md](configuration.md#page-metadata).
- Any static file; no build step. Dot paths and `data.sqlite*` are never served. Responses are `no-store`.
- Served HTML includes the SDK and a bottom-right robot button. Open it for the page agent's chat; closing preserves the draft. API: [spur-sdk.md](spur-sdk.md).

## Home screen

- Each page supplies its own title, favicon, touch icon and standalone web manifest. Install through the browser's install or Add to Home Screen command.
- Pages require a connection. No offline cache or queued offline messages.
- Ask the page agent to change the title or icon. It edits `page.yaml` and creates a local square PNG; 512px recommended. Changes reload open tabs. Installed icon refresh depends on the browser and OS.

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
