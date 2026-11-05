# Session snippets

> Scope: interactive session snippet authoring contract. SDK and components: [spur-sdk.md](spur-sdk.md). Actions and the agent envelope: [stores.md](stores.md#actions). Limits: `packages/web/src/lib/snippets/snippet-protocol.ts`.

Agent writes one HTML file; the session page renders it as a sandboxed panel. Data and state live in a store; user actions reach the owning session as `[spur-action v1]` messages.

## Publish

- Path: `$SPUR_SESSION_ARTIFACTS_DIR/snippet.$SPUR_SESSION.<snippetId>.html`, directory root only.
- `snippetId`: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, equals the file slug.
- Write `<file>.tmp` in the same directory, then `mv` over the final name. Delete the file to remove the panel.
- Reserved names: `snippet.<session-id>.*` (`<prefix>-<4 hex>`). They leave the Artifacts grid, counts and preview navigation. Foreign-owner and `.tmp` files are hidden. Other `snippet.*` names stay ordinary artifacts.
- File over 256 KiB: not rendered, error card. 4 panels mount per session, newest first; the rest are listed by name.

## Manifest

First `<script type="application/spur-snippet+json">` in the file. Unknown keys rejected at every level. Full shape: [Example](#example).

- Keys: `protocolVersion` (`2`), `snippetId`, `ownerSessionId` (this session's id), `instanceId`, `revision`, `store` (optional), `title`, `actions`.
- `protocolVersion: 1` files render an error card: rewrite with `2`.
- `store`: data store for `spur.db` and `spur.state`, `page:<id>` or `session:<owner>`; default `session:<owner>`. Agent store: [spur-sdk.md](spur-sdk.md#stores).
- `instanceId`: `[A-Za-z0-9-]{8,64}`, fixed for the snippet's life. New value = new snippet: state and last action reset.
- `revision`: integer 1..2147483647, strictly increasing within an `instanceId`.
- `title` 1..120 chars, action `label` 1..80 chars; banned characters: action `label` in [stores.md](stores.md#actions).
- `actions`: 1..32 of `{id, label, payload, confirm?}`; ids unique `^[a-z0-9][a-z0-9-]{0,63}$`. `"confirm": "always"`: every invoke asks the user first.

## Payload schema

Root is an object schema. Every string needs `maxLength` 1..20000; every array needs `maxItems` 1..100. Undeclared properties are rejected. Nesting depth 4 (root object = 1).

- `object`: `properties` 1..32 keys `^[a-zA-Z][a-zA-Z0-9_]{0,31}$`, `required` (subset).
- `string`: `maxLength`, `minLength`, `enum` (1..100 values, each up to 200 chars and `maxLength`).
- `number`: `minimum`, `maximum`, `integer: true`.
- `boolean`.
- `array`: `items`, `maxItems`, `minItems`.
- `selection`: `maxLength` bounds `text`. Value `{sourceId, text, start, end, quote}`, UTF-16 offsets, `quote` equals `text.slice(start, end)`.
- Not supported: `pattern`, `$ref`, `oneOf`, `anyOf`, `format`, `additionalProperties`.

## Actions

`spur.agent.invoke(actionId, payload)`: the session gets one `[spur-action v1]` message; close it per [stores.md](stores.md#actions). Result shapes: [spur-sdk.md](spur-sdk.md#invoke).

- Panel status from the doc: Queued, Agent working (session working), Done, Failed, No reply in 15 min (daemon expiry). Host Retry on Failed and timeout.
- Host asks the user before an invoke when: the action declares `confirm`, the snippet never had focus, second action on the same revision, 10 unconfirmed sends in a row, or browser storage is unavailable. `spur.agent.send` and `<spur-chat>` pass the same gates except the per-revision one. The count resets only on the user's Send or Retry click.
- Reload while sending: the panel shows the latest action of this instance from the store; an unacknowledged send is lost.
- Payload up to 48 KiB, port message up to 128 KiB. Unit: UTF-8 bytes of the JSON text.

## Revisions

- Higher revision, same `instanceId`: new document, state and control values carry over.
- Same revision, different text: first copy stays, actions blocked until a higher revision.
- Lower revision, wrong owner, invalid manifest: ignored, error card.
- A revision answers nothing by itself; actions close only through `spur db ... done|fail`.

## Sandbox

- Iframe `sandbox="allow-scripts"` only; opaque origin: no dashboard cookies, storage or DOM.
- CSP in the srcdoc: no network, assets inline or `data:`/`blob:`; no form submit, no popups, no `alert`.
- Not blocked: WebRTC (network egress), DNS prefetch, self-navigation. A second page load stops the panel with Reload.
- Over 100 port messages in 10 s stops the panel.
- Unconfirmed-send count is per session per browser profile, no cross-tab lock: racing tabs reach at most 10 x open tabs.
- Reverse proxy: a CSP header added to Spur pages must allow `'unsafe-inline'` scripts and styles, or snippets do not start.

## Example

Ten variants, choose, regenerate with an instruction, modify a selected span. No script.

```html
<script type="application/spur-snippet+json">
  {
    "protocolVersion": 2,
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
