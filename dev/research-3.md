# Research: Open-Source Projects Using Claude Code Hooks for Status Detection

## 1. Eyes on Claude Code (EOCC)

**URL:** https://github.com/joe-re/eyes-on-claude-code

### Hooks Used

Registers 6 hook event types in `~/.claude/settings.json`:

| Hook Event          | Usage                                                    |
|---------------------|----------------------------------------------------------|
| `SessionStart`      | Creates session with `Active` status; caches tmux/npx paths |
| `SessionEnd`        | Removes session from state                               |
| `Stop`              | Sets session status to `Completed`; caches paths         |
| `UserPromptSubmit`  | Sets session status to `Active` (user is working)        |
| `PostToolUse`       | Sets session status to `Active`                          |
| `Notification`      | Splits by matcher: `permission_prompt` -> `WaitingPermission`, `idle_prompt` -> `WaitingInput` |

Each hook is a separate invocation of the `eocc-hook` Node.js script with the event type as argv: `eocc-hook stop`, `eocc-hook notification permission_prompt`, etc.

### How Hook State and Terminal Output Combine

EOCC does **not** read terminal output for state detection. It relies entirely on hooks for session status. However, it has a tmux integration layer that captures pane content for display:

- `tmux_capture_pane` reads the visible tmux pane content for display in a TmuxViewer component
- `tmux_send_keys` sends keystrokes to tmux panes (for interactive control)
- Session status is purely hook-driven; tmux is only for visual output

The architecture is: hooks write to `~/.eocc/logs/events.jsonl` -> file watcher detects changes -> Rust backend processes events -> updates in-memory state -> emits to React frontend.

### State Machine

```
SessionStart      -> Active
UserPromptSubmit  -> Active
PostToolUse       -> Active
Stop              -> Completed
Notification(permission_prompt) -> WaitingPermission
Notification(idle_prompt)       -> WaitingInput
SessionEnd        -> (removed from state)
```

The `SessionStatus` enum: `Active | WaitingPermission | WaitingInput | Completed`.

### Staleness/Freshness Logic

EOCC has **no explicit staleness timeout**. Key freshness mechanisms:

1. **Atomic file rotation:** On each poll cycle, `events.jsonl` is atomically renamed to `events.processing.<ts>.<pid>.jsonl`, a fresh empty file is created, then the processing file is read line-by-line and deleted. This prevents data loss if the hook writes during processing.

2. **Persisted runtime state:** On every state change, the full session map + recent events are serialized to `runtime_state.json`. On app restart, this is restored so sessions survive app restarts. But there is no TTL -- a session marked `Active` before the app was killed stays `Active` forever until a new hook event arrives.

3. **File watcher (not polling):** Uses `notify` crate's `RecommendedWatcher` on the log directory. Events are processed as soon as the OS reports a file change, rather than on a fixed interval.

4. **No heartbeat:** If Claude Code crashes without firing `Stop` or `SessionEnd`, the session stays in its last known state indefinitely. There is no timeout-based garbage collection.

### Key Implementation Details

- **Language:** Rust (Tauri) backend + React/TypeScript frontend. Desktop app (menubar/tray).
- **Hook script:** Single Node.js file (`eocc-hook`) that reads stdin JSON, extracts fields, and appends a flat JSON line to `~/.eocc/logs/events.jsonl`.
- **Symlink trick:** Hook script is installed to `~/.local/bin/eocc-hook` as a symlink to avoid spaces in the path (Tauri app data paths can contain spaces).
- **State keying:** Sessions are keyed by `project_dir` (or `project_name` if dir is empty), not by `session_id`. This means one session per project directory.
- **50-event ring buffer:** `recent_events` is a `VecDeque` capped at 50 entries.
- **Setup flow:** App generates the merged `settings.json` hooks config and shows it to the user in a setup modal to copy-paste.
- **No server component:** Purely local. Hook -> JSONL file -> file watcher -> in-memory state -> Tauri IPC -> React.

---

## 2. Agents Observe (Claude Observe)

**URL:** https://github.com/simple10/agents-observe

### Hooks Used

Registers hooks for **every** Claude Code hook event type via a plugin `hooks.json`:

```
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
PostToolUseFailure, PermissionRequest, Stop, StopFailure, SubagentStart,
SubagentStop, TeammateIdle, TaskCreated, TaskCompleted, Notification,
InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, PreCompact,
PostCompact, Elicitation, ElicitationResult, WorktreeCreate, WorktreeRemove
```

All 25+ event types go through the same pipeline: `hook.sh` -> `observe_cli.mjs hook` -> POST to API server.

### How Hook State and Terminal Output Combine

Agents Observe does **not** read terminal output at all. It is a pure hook-event pipeline:

1. **Hook shell wrapper** (`hook.sh`): Reads stdin, backgrounds the Node.js CLI, exits immediately (~2-5ms). This is critical because Claude Code hooks block until the command exits.
2. **CLI** (`observe_cli.mjs`): Parses JSON from stdin, wraps it in an envelope with project slug metadata, POSTs to the API server.
3. **Server** (`events.ts` route): Parses the raw event via `parser.ts`, resolves project, upserts session, tracks agent hierarchy, inserts event into SQLite, broadcasts via WebSocket.
4. **Client** (React dashboard): All state derivation happens client-side. The server is a "dumb store."

### State Machine (Server-Side)

Session status transitions in `events.ts`:

```
SessionEnd event  -> session.status = 'stopped'
Any other event on a 'stopped' session -> session.status = 'active' (reactivation)
Default for new sessions -> 'active'
```

Event-level status for tool events:
```
PreToolUse  -> status = 'running'
PostToolUse -> status = 'completed'
Everything else -> status = 'pending'
```

### Staleness/Freshness Logic

Agents Observe has **minimal staleness handling**:

1. **Client polling:** `useSessions` hook re-fetches sessions every 30 seconds (`refetchInterval: 30_000`).
2. **WebSocket live updates:** Session status changes are broadcast immediately via WebSocket to subscribed clients.
3. **No TTL/timeout:** Like EOCC, there is no heartbeat or timeout. If a session never receives a `SessionEnd` event, it stays `active` forever.
4. **Reactivation:** If a stopped session receives any new event, it is automatically reactivated to `active`. This handles the case where a session resumes.

### Transcript JSONL Reading

Agents Observe has a **callback mechanism** for reading Claude Code's transcript JSONL files:

- When the server receives an event with a `transcript_path` and the session has no `slug`, it sends a callback request back to the CLI.
- The CLI's `callbacks.mjs` reads the transcript JSONL file line-by-line looking for an entry with a `slug` field.
- It then POSTs the slug back to the server to update session metadata.
- This is gated behind `AGENTS_OBSERVE_ALLOW_LOCAL_CALLBACKS` config for security.

The parser (`parser.ts`) also has a **transcript JSONL format** branch (lines 104-166) that can parse raw JSONL entries from Claude Code transcripts (not just hook events). It handles `progress`, `assistant`, and `toolUseResult` message types, extracting agent IDs, tool names, and subagent info from the transcript format.

### Key Implementation Details

- **Language:** Node.js/TypeScript server (Hono framework) + React/TypeScript client. Runs in Docker or locally.
- **Architecture:** Hook -> bash wrapper (backgrounds node) -> CLI POSTs to HTTP API -> SQLite storage -> WebSocket broadcast -> React dashboard.
- **Agent hierarchy tracking:** Tracks parent-child agent relationships using `agent_id` from hook payloads and `PreToolUse:Agent` / `PostToolUse:Agent` events. Uses a FIFO queue per session for early naming of subagents before their `PostToolUse` event arrives.
- **Dual format parser:** `parseRawEvent()` handles both hook format (identified by `hook_event_name` field) and transcript JSONL format (identified by `type` field). This means it can ingest events from hooks OR from direct JSONL file reading.
- **Fire-and-forget mode:** When no callbacks are configured, the CLI POSTs with `fireAndForget: true`, meaning it doesn't wait for the server response. This minimizes hook execution time.
- **Plugin distribution:** Ships as a Claude Code plugin with `hooks.json` and `.claude-plugin/plugin.json`. Users install by adding the plugin, not by manually editing settings.json.
- **In-memory caches:** The server maintains several in-memory maps (`sessionRootAgents`, `pendingAgentMeta`, `pendingAgentMetaQueue`, `namedAgents`) for tracking agent metadata across events. These are not persisted and reset on server restart.

---

## Comparison Summary

| Aspect | EOCC | Agents Observe |
|--------|------|----------------|
| Hook events used | 6 (targeted) | 25+ (all available) |
| State derivation | Rust backend, in-memory | Server stores in SQLite, client derives |
| Terminal output | tmux capture for display only | None |
| JSONL transcript reading | No | Yes (callback mechanism + dual parser) |
| Staleness/TTL | None | None |
| Session status model | 4 states (Active, WaitingPermission, WaitingInput, Completed) | 2 states (active, stopped) |
| Distribution | Desktop app (Tauri) | Docker/local server + web dashboard |
| Hook blocking mitigation | Synchronous Node.js (fast enough) | bash wrapper backgrounds node process |
| Persistence | `runtime_state.json` flat file | SQLite database |
| Agent hierarchy | No (one session per project) | Yes (parent-child agent tree) |
