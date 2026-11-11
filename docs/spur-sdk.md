# Spur SDK

> Scope: `window.spur` API and components, same for pages and snippets. Pages: [pages.md](pages.md). Snippets: [snippets.md](snippets.md). Stores and actions: [stores.md](stores.md). Source: `packages/web/public/spur/spur-sdk.v2.js`.

One SDK file, two transports. Page: injected into served HTML, fetch plus one event stream at the Page root. Snippet: host inlines it, every call crosses the host port. Same API either way.

## Stores

- Data store: page `page:<id>`; snippet manifest `store`, default `session:<owner>`.
- Agent store (actions, chat): page `page:<id>`; snippet always `session:<owner>`.
- The SDK never names a store; it reaches only these two.

## API

- `ready(): Promise<context>`; context includes `dataStore`, `agentStore`, `state`; snippets add `snippetId`, `instanceId`, `revision`, `previousRevision`, `action`, `actions`, `theme`, `fullscreen`, `availability`.
- `db.collection(c)`: `add(data)`, `get()`, `where(field, op, value)`, `orderBy(field, "asc"|"desc")`, `limit(n)`, `startAfter(docId)`, `onSnapshot(cb, onError?)` (returns unsubscribe; reruns on store changes).
- `db.collection(c).doc(id)`: `get()` (`null` when missing), `set(data, {expectedRev?})`, `update(patch, {expectedRev?})` (JSON merge patch), `delete()`. Query ops and limits: [stores.md](stores.md).
- `state.get()`, `state.set(value)`: `_state` doc in the data store, up to 64 KiB, throws `RangeError` over it, saved 500 ms after the last change. Page doc `page`; snippet doc `snippet-<12 hex sha256(owner)>-<snippetId>`, reset when `instanceId` changes.
- `agent.invoke(action, payload)`, `agent.retry()`: [Invoke](#invoke).
- `agent.send(text)`: message to the store owner. Resolves `{ok: true, sessionId}` or `{ok: false, reason, error?}`.
- `agent.onMessage(cb)`: `{index, role, kind, text, timestampMs?, textTruncated?}`, polled every 2 s; returns unsubscribe. `kind`: `chat` (sent by `agent.send` or `spur-chat`), `action` (this store's `[spur-action v1]`, `text` = label), `reply` (agent). Other messages to the agent are omitted. Only the latest 100 distinct sends count as `chat`; older user lines drop from the history after a reload while replies stay.
- `agent.status()`: `{state, sessionId}`; `state`: `none`, `working`, `idle`, `recovering`, `error`, `rate_limited`.
- `on(event, handler)`, `once(...)`: `action`, `agent`, `message`, `theme`, `fullscreen`, `availability`. Returns unsubscribe.
- `action`: current `{id, action, payload, status, error?, result?}` or `null`. Status: `awaiting_confirm`, `submitting`, `queued`, `processing`, `completed`, `error`, `timeout`.
- `requestFullscreen(): Promise<boolean>` (snippet: false until it had focus), `exitFullscreen()`.
- `selection(sourceId?)`: current selection in a `spur-selectable-text`.
- Theme: `--spur-<token>` custom properties on `:root`, font `--spur-font`. Snippet: host tokens, `theme` event on change. Page: `/p/<id>/_spur/theme.css` supplies `light-dark()` pairs for `--spur-text-tertiary` and `--spur-status-{error,ready,working,attention}`; page CSS overrides them.

## Invoke

Writes an `_actions` doc in the agent store; the owner gets one `[spur-action v1]` message and closes it with `spur db <store> done|fail <id>` ([stores.md](stores.md#actions)).

- Resolves once the doc closes: `{ok: true, id, result}`; `{ok: false, reason: "failed", id, error}`; `{ok: false, reason: "timeout", id}`.
- Rejected before delivery, nothing sent: `{ok: false, reason, issues?}`; `reason`: `not_connected`, `unknown_action`, `payload_too_large`, `invalid_payload`, `session_unavailable`, `busy`, `declined`, `stale`.
- `issues` (snippet schema): up to 20 `{path, code}`; `code`: `type`, `required`, `unknown_property`, `min_length`, `max_length`, `enum`, `minimum`, `maximum`, `integer`, `min_items`, `max_items`, `selection_mismatch`, `depth`.
- One action in flight. `retry()` re-invokes the last `error` or `timeout` action with its payload, new id, `retryOf` = old id.
- Page actions: undeclared; name and payload limits in [stores.md](stores.md#actions). Snippet actions: declared in the manifest, payload checked against its schema.
- User gesture: only a trusted click or submit on a library control counts. Automated page sends are budgeted ([pages.md](pages.md#page-agent)).

## Components

- `<spur-choice-list name mode="single|multiple" label>` with `<spur-choice value>` children. `label`: header row with a live `N of M selected` count; also sets `aria-label`.
- `<spur-text-input name maxlength placeholder label>`, `<spur-textarea name maxlength rows placeholder label>`.
- `<spur-selectable-text source-id>`, `<spur-selection-toolbar for="<ids>" field="selection">`.
- `<spur-form action>`: payload is `{name: value}` of descendant fields; empty strings omitted. Enter in a text input submits.
- `<spur-button action form payload variant="primary|secondary|danger" type="submit">`: static `payload` JSON merged under form fields; inside a toolbar adds the selection under `field`.
- `[data-spur-action="<id>"][data-spur-payload='<json>']`: any element invokes on click.
- `<spur-status>`: action status, Retry, rejection text. Without one, a rejection renders one `<spur-error data-spur-fallback>` at the end of `body`.
- `<spur-chat placeholder>`: message log, agent status, multiline draft (20,000 chars); SEND uses `agent.send`. Text renders as plain text.
- Chat voice inserts into the editable draft; SEND stays explicit. Page microphone lives in the composer; snippet microphone lives in trusted panel controls. Recording/transcription failures preserve text; failed audio can be retried or discarded. Voice providers: [voice.md](voice.md).
- `<spur-loader aria-label>`, `<spur-empty>`, `<spur-error>`.
- Fields with an `id` persist their value through `state`.
- While an action is in flight, or actions are blocked, every library control and `[data-spur-action]` element is disabled.
