# Pages

> Scope: Spur pages — files, `page.yaml`, URL, live events. Store: [stores.md](stores.md). CLI: [commands.md#db-page](commands.md#db-page). Owner: `v2/src/pages.ts`.

A page is a static web app in `<dataDir>/pages/<id>/` with its own store `page:<id>`. The web UI serves it at `/p/<id>/`.

Open the project menu → Pages for the catalogue. Titles open pages in a new tab; Agents returns to the dashboard with the selected project. The catalogue lists readable, valid page configurations; it does not check the entry document.

## Create

```sh
spur page create films --title Films
spur page path films        # edit files here
spur db page:films add items '{"title":"Dune"}'
```

- Id `^[a-z0-9][a-z0-9-]{0,39}$`. A page exists while its dir exists.
- Template `blank`: `index.html` listing collection `items`, plus `<spur-chat>`.

## Files

- `page.yaml`: [configuration reference](configuration.md).
- Any static file; no build step. Dot paths, `data.sqlite*`, `page.yaml` and `_spur` paths are protected at every depth. Responses are `no-store`; `_spur` serves the native SDK/API.
- Load the SDK with `<script src="./_spur/sdk.js"></script>`. API: [spur-sdk.md](spur-sdk.md).

## Publish from sources

Create with `spur page create films --source ./site`; bind an existing Page with `spur page source films ./site`.

- Folder source: publish its nonreserved contents; requires `index.html`.
- HTML source: publish its parent folder, including siblings; use a curated folder to limit publication.
- Selected `.html`/`.htm`: keep its name and publish as `index.html`, replacing a sibling entry.
- Paths refer to the daemon host; CLI resolves relative paths to absolute paths before submission.
- Initial sync attempt finishes before the command returns; the daemon checks sources every 2 seconds without open tabs, agents or site servers.
- Edits, additions and imported-file deletions preserve Page ID, URL, native SQL and protected paths.
- Import replaces matching static files; unrelated publication files remain.
- `spur page list`: source path, sync state and errors; `--json` adds resolved root and last successful sync time when available.
- States: `pending`, `syncing`, `synced`, `error`; unchanged checks retain success time.
- Missing/unreadable source, missing entry, prohibited links or invalid sync metadata report errors.
- Validation failures retain publication; restored sources retry automatically.
- Write failures can leave partial static updates until retry; SQL remains intact.
- Reject symlinks, special files and source roots overlapping Page storage.
- Exclude protected paths before traversal; local dependencies must stay inside source root without links.
- `spur page source films --detach`: stop updates, retain publication/SQL.
- Rebind: remove obsolete imported files after successful import.
- No source: retain manual editing behavior.

Do not edit hidden source-sync state in the publication directory. Edit source files while bound; source updates replace matching publication files.

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
