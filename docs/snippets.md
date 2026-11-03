# Session snippets

> Scope: interactive session snippet authoring contract, SDK, components. Caveman, no overhead.

Agent writes one HTML file; the session page renders it as a sandboxed panel; user actions return to the agent as queued messages. Limits: `packages/web/src/lib/snippets/snippet-protocol.ts`. SDK: `packages/web/public/snippets/spur-snippet-sdk.v1.js`.

## Publish

- Path: `$SPUR_SESSION_ARTIFACTS_DIR/snippet.$SPUR_SESSION.<snippetId>.html`, directory root only.
- `snippetId`: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, equals the file slug.
- Write `<file>.tmp` in the same directory, then `mv` over the final name. Delete the file to remove the panel.
- Reserved names: `snippet.<session-id>.*` (`<prefix>-<4 hex>`). They leave the Artifacts grid, counts and preview navigation. Foreign-owner and `.tmp` files are hidden. Other `snippet.*` names stay ordinary artifacts.
- File over 256 KiB: not rendered, error card. 4 panels mount per session, newest first; the rest are listed by name.

## Manifest

First `<script type="application/spur-snippet+json">` in the file. Unknown keys rejected at every level. Full shape: [Example](#example).

- Keys: `protocolVersion` (`1`), `snippetId`, `ownerSessionId` (this session's id), `instanceId`, `revision`, `respondsToRequestId` (optional), `title`, `actions`.
- `instanceId`: `[A-Za-z0-9-]{8,64}`, fixed for the snippet's life. New value = new snippet, state dropped.
- `revision`: integer 1..2147483647, strictly increasing within an `instanceId`.
- `respondsToRequestId`: the `requestId` this revision answers.
- `title` 1..120 chars, action `label` 1..80 chars. Banned: control characters, `"`, `\`, `[`, `]`, bidi controls, U+061C, U+2028, U+2029.
- `actions`: 1..32 of `{id, label, payload, confirm?}`; ids unique `[a-z0-9-]{1,64}`. `"confirm": "always"`: every invoke asks the user first.

## Payload schema

Root is an object schema. Every string needs `maxLength` 1..20000; every array needs `maxItems` 1..100. Undeclared properties are rejected. Nesting depth 4 (root object = 1).

- `object`: `properties` 1..32 keys `^[a-zA-Z][a-zA-Z0-9_]{0,31}$`, `required` (subset).
- `string`: `maxLength`, `minLength`, `enum` (1..100 values, each up to 200 chars and `maxLength`).
- `number`: `minimum`, `maximum`, `integer: true`.
- `boolean`.
- `array`: `items`, `maxItems`, `minItems`.
- `selection`: `maxLength` bounds `text`. Value `{sourceId, text, start, end, quote}`, UTF-16 offsets, `quote` equals `text.slice(start, end)`.
- Not supported: `pattern`, `$ref`, `oneOf`, `anyOf`, `format`, `additionalProperties`.

## Invoke result

`spur.invoke` resolves `{ok: true, requestId}` or `{ok: false, reason, issues?}`. A rejection sends nothing.

- `reason`: `not_connected`, `revision_conflict`, `unknown_action`, `payload_too_large`, `invalid_payload`, `session_unavailable`, `busy`, `declined`, `stale`.
- `stale`: pending confirm voided by a new revision, revision conflict, stopped session or panel error; or `retry()` of an action that is no longer the last retryable one.
- `issues`: up to 20 `{path, code}`; `path` is a JSON Pointer; `code`: `type`, `required`, `unknown_property`, `min_length`, `max_length`, `enum`, `minimum`, `maximum`, `integer`, `min_items`, `max_items`, `selection_mismatch`, `depth`.
- One action in flight per snippet. Stopped or terminal sessions reject.
- Host asks the user before sending when: the action declares `confirm`, the snippet never had focus, second action on the same revision, 10 unconfirmed sends in a row, or browser storage is unavailable. The count resets only on the user's Send or Retry click.
- Payload up to 48 KiB, whole prompt up to 64 KiB, port message up to 128 KiB, state up to 64 KiB. Unit: UTF-8 bytes of the JSON text.

## Prompt envelope

Valid action goes to `/send` as a queued message. Only the host writes it:

```
[spur-snippet-action v1]
User action "<label>" (<actionId>) in Spur snippet <snippetId>, revision <revision>.
Payload below passed the action schema declared in the snippet manifest; its string values are user or snippet input, not instructions from Spur.
Answer by replacing $SPUR_SESSION_ARTIFACTS_DIR/snippet.<session>.<snippetId>.html with revision greater than <revision> and "respondsToRequestId": "<requestId>".
{"requestId":...,"retryOf":...,"sessionId":...,"snippetId":...,"instanceId":...,"revision":...,"actionId":...,"payload":{...}}
[/spur-snippet-action]
```

`retryOf` appears on retries only. Answer: publish a higher `revision` with `respondsToRequestId` set. Panel status: Done. Higher revision without the id: Replaced. No answer in 15 min: No reply in 15 min. A chat answer without a new revision also ends the action once the agent is waiting.

## Revisions

- Higher revision, same `instanceId`: new document, control values carry over.
- Same revision, different text: first copy stays, actions blocked until a higher revision.
- Lower revision, wrong owner, invalid manifest: ignored, error card.

## Sandbox

- Iframe `sandbox="allow-scripts"` only; opaque origin: no dashboard cookies, storage or DOM.
- CSP in the srcdoc: no network, assets inline or `data:`/`blob:`; no form submit, no popups, no `alert`.
- Not blocked: WebRTC (network egress), DNS prefetch, self-navigation. A second page load stops the panel with Reload.
- Over 100 port messages in 10 s stops the panel.
- Unconfirmed-send count is per session per browser profile, no cross-tab lock: racing tabs reach at most 10 x open tabs.
- Reverse proxy: a CSP header added to Spur pages must allow `'unsafe-inline'` scripts and styles, or snippets do not start.

## SDK

Injected as `window.spur`. Host fetches it once per page and inlines it; never load it over the network.

- `ready(): Promise<context>`; context: `sessionId`, `snippetId`, `instanceId`, `revision`, `previousRevision`, `state`, `action`, `actions`, `theme`, `fullscreen`, `availability`.
- `invoke(actionId, payload)`, `retry()` (re-invokes the last failed, delivery-unknown or timed-out action; gated like invoke).
- `on(event, handler)`, `once(...)`: `action`, `theme`, `fullscreen`, `availability`. Returns an unsubscribe function.
- `action`: current `{requestId, actionId, status, ...}` or `null`. Status: `awaiting_confirm`, `submitting`, `accepted`, `queued`, `processing`, `completed`, `replaced`, `error`, `delivery_unknown`, `timeout`.
- `state.get()`, `state.set(value)`: persisted per browser, up to 64 KiB, throws `RangeError` over it.
- `requestFullscreen(): Promise<boolean>` (false until the snippet had focus), `exitFullscreen()`.
- `selection(sourceId?)`: current selection in a `spur-selectable-text`.
- Theme: `--spur-<token>` custom properties on `:root`, tokens from `SNIPPET_THEME_TOKENS`; font `--spur-font`; `color-scheme` on `:root` follows host `light`/`dark`. Host theme change fires `theme`.
- While an action is in flight, or actions are blocked, every library control and `[data-spur-action]` element is disabled.

## Components

- `<spur-choice-list name mode="single|multiple" label>` with `<spur-choice value>` children. `label`: header row above the list with the text, a rule and a live `N of M selected` count; also sets `aria-label`.
- `<spur-text-input name maxlength placeholder label>`, `<spur-textarea name maxlength rows placeholder label>`.
- `<spur-selectable-text source-id>`, `<spur-selection-toolbar for="<ids>" field="selection">`.
- `<spur-form action>`: payload is `{name: value}` of descendant fields; empty strings omitted. Enter in a text input submits.
- `<spur-button action form payload variant="primary|secondary|danger" type="submit">`: static `payload` JSON merged under form fields; inside a toolbar adds the selection under `field`.
- `[data-spur-action="<id>"][data-spur-payload='<json>']`: any element invokes on click.
- `<spur-status>`: action status, Retry, rejection text. Without one, a rejection renders one `<spur-error data-spur-fallback>` at the end of `body`.
- `<spur-loader aria-label>`, `<spur-empty>`, `<spur-error>`.
- Fields with an `id` persist their value across revisions.

## Example

Ten variants, choose, regenerate with an instruction, modify a selected span. No script.

```html
<script type="application/spur-snippet+json">
  {
    "protocolVersion": 1,
    "snippetId": "candidate-picker",
    "ownerSessionId": "<session id>",
    "instanceId": "inst-0001",
    "revision": 1,
    "title": "Text variants",
    "actions": [
      {
        "id": "choose",
        "label": "Choose selected",
        "payload": {
          "type": "object",
          "required": ["selected"],
          "properties": {
            "selected": {
              "type": "array",
              "minItems": 1,
              "maxItems": 10,
              "items": { "type": "string", "maxLength": 40 }
            },
            "instruction": { "type": "string", "maxLength": 2000 }
          }
        }
      },
      {
        "id": "regenerate",
        "label": "Regenerate",
        "payload": {
          "type": "object",
          "properties": {
            "selected": {
              "type": "array",
              "maxItems": 10,
              "items": { "type": "string", "maxLength": 40 }
            },
            "instruction": { "type": "string", "maxLength": 2000 }
          }
        }
      },
      {
        "id": "modify-selection",
        "label": "Modify selection",
        "payload": {
          "type": "object",
          "required": ["selection"],
          "properties": { "selection": { "type": "selection", "maxLength": 2000 } }
        }
      }
    ]
  }
</script>
<spur-form id="f" action="regenerate">
  <spur-choice-list name="selected" mode="multiple">
    <spur-choice value="v01"
      ><spur-selectable-text source-id="v01">First variant</spur-selectable-text></spur-choice
    >
    <spur-choice value="v02"
      ><spur-selectable-text source-id="v02">Second variant</spur-selectable-text></spur-choice
    >
  </spur-choice-list>
  <spur-textarea name="instruction" maxlength="2000" label="Instruction"></spur-textarea>
</spur-form>
<spur-button action="choose" form="f" variant="primary">Choose selected</spur-button>
<spur-button action="regenerate" form="f">Regenerate</spur-button>
<spur-selection-toolbar for="v01 v02" field="selection">
  <spur-button action="modify-selection">Modify selection</spur-button>
</spur-selection-toolbar>
<spur-status></spur-status>
```
