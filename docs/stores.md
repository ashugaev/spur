# Stores

> Scope: page and session document stores — ids, collections, queries, limits, CLI. Routes: [daemon-api.md#store-routes](daemon-api.md#store-routes). Owner: `v2/src/stores.ts`.

One SQLite file per store, Firestore-style documents.

## Store ids

- `page:<pageId>` — page store, file in the page dir. `404` when the page dir is absent.
- `session:<sid>` — session store, file in the session's (desk anchor's) work dir; removed with the session's artifacts. `404` unknown session. Writes `409` once the session is `completed`, `killed` or `errored`; reads stay `200`.

## Documents

- Collection `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`; doc id `^[A-Za-z0-9_-]{1,128}$`; `add` generates a 20-hex id.
- Doc: `{id, rev, createdAt, updatedAt, data}`; `data` is a JSON object; `rev` starts at 1, +1 per write.
- `set` replaces, `update` merge-patches (RFC 7386, `null` removes a key), `rm` deletes. `expectedRev` mismatch: `409`; `expectedRev: 0` = doc must be absent.
- `_actions`: read-only through doc routes (`400` on write). `_state`: writable.

## Queries

- `where`: up to 8 `{field, op, value}`; `op` one of `== != < <= > >= in contains`; `in` takes 1..30 values; `contains` matches an array element.
- `field`: dotted path into `data`, `^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$`. Values: string, finite number, boolean, `null`.
- `orderBy {field, direction}`, ties by id; default order id ascending. `limit` default 100, max 500. `startAfter`: doc id cursor.

## Changes

- Every write appends `{seq, collection, id, op: set|delete, rev}`; last 10000 rows kept.
- `GET /stores/<store>/changes?since=<seq>` pages 500 rows. `reset: true`: cursor pruned or ahead of the store, refetch.

## Limits

- Document 262144 bytes, store file 64 MiB: `413`. Request body over 1000000 bytes: `500`.

## CLI

`spur db <store> get|list|query|add|set|update|rm` — [commands.md#db](commands.md#db).

```sh
spur db page:films add items '{"title":"Dune"}'
spur db page:films query items '{"where":[{"field":"watched","op":"==","value":false}]}'
spur db session:$SPUR_SESSION update notes n1 '{"done":true}' --rev 2
```
