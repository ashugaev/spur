# Work snapshots

> Scope: how-to for agent work snapshots: when Spur asks for one, what counts as work, config keys. Caveman, no overhead.

A snapshot is a full Markdown handoff of the session's state, stored as the next numbered version. Write one so a successor, a compaction, or a human can resume without the transcript.

Recommended sections: Now, Established, Tried, Next, Questions and risks, References.

Write: `spur snapshot write <sessionId> --file <path|->` ([commands](commands.md#todo-snapshot)). Inside a session use the wrapper path from the request text; it works without `$SPUR_*` env vars.

## When Spur asks

Request text starts `Spur snapshot is stale:`. Sent when agent work lies more than `freshnessMinutes` (N) past the latest snapshot, or past session start when none exists.

- Pane: while the session waits, ahead of ToDo nudges. All agents.
- Claude hooks: after a tool call (at most once per N/2 window) and at turn end. A complying agent's latest snapshot lags its last tool use by at most N + N/2.
- Gap: 60 s after any delivered reminder. 3 attempts per snapshot version; a new snapshot resets them.
- Spur ToDo nudges and the request itself do not count as work.

## What counts as work

Agent output after the latest snapshot. Transcript file activity alone never counts.

- Turn started by you or a trigger: assistant text, reasoning, tool calls.
- Turn started by a Spur reminder (ToDo nudge, snapshot request): only tool calls that are not Spur session tools. Text, reasoning and `spur-todo`/`spur-snapshot`/`spur-slots` calls never count.
- A command mixing real work with a Spur tool call counts as a Spur call.
- An idle session whose only activity is answering reminders is never asked.

Providers:

- Claude, Codex: per-entry timestamps, exact rule above.
- Cursor, OpenCode: no per-entry timestamps. No request when the latest turn started from a Spur reminder; otherwise last activity time counts.

## Config

Per project, `projects.<id>.snapshots` ([configuration](configuration.md#field-reference)); defaults from `v2/src/snapshots.ts`:

- `enabled` (`true`): `false` stops pane and Claude hook requests. CLI and HTTP snapshot writes stay usable.
- `freshnessMinutes` (`30`): N.
- `maxBytes` (`32768`, max `131072`): bytes per snapshot.
- `requireFinal` (`false`): agent `complete`/`self-destruct` need a `--final` snapshot, `handoff` any, else `409 work_snapshot_required`. `requireFinal: true` with `enabled: false` fails config load, error names both keys.

```yaml
projects:
  api:
    snapshots:
      freshnessMinutes: 20
```

Config applies at daemon start, spawn, restore and relaunch; a Claude session picks up an edit at the next of those. Running sessions get the current hook and command at the first sweep after daemon start, no restart. Claude sessions started before this behavior have no `UserPromptSubmit` hook: the Claude hook stays silent until relaunch, pane requests still apply.

## Limits

- Launch prompt text still names `$SPUR_SNAPSHOT_COMMAND`, also with `enabled: false`.
- Pane check reads the newest 300 transcript entries. Work older than that, with only reminder turns since, is not found.
- Codex entries without a timestamp never meet the freshness threshold; they only mark turn boundaries.
- Reminder text is matched by its opening words. A reminder reply that runs a non-Spur tool counts as work; one request per N at most.
