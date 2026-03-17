# Spur Test Scenarios

Keep this file lean. Expand it every time Spur gets a new feature or a new failure mode that must stay covered.

## Core

- `info`: returns runtime info for the running daemon.
- `list`: empty on fresh state, includes stored sessions later.
- CLI auto-start: if a daemon is already running on the configured `host`/`port`, later commands reuse it instead of treating config-path drift as an error.

## Spawn Lifecycle

- `spawn`: creates session id, worktree, symlinks, tmux session, and launches the selected agent.
- `spawn`: accepts the prompt only as the positional `<prompt...>` argument.
- Default `spawn`: uses project default agent and `sessionId` as branch when flags are omitted.
- `get`: returns persisted session plus live `runtimeAlive`, `workspaceExists`, `activity`, and `lastActivityAt`.
- `send`: reaches the running agent and updates session metadata.
- `kill`: kills tmux, removes worktree, keeps terminal metadata with `killed` status.
- `get` after `kill`: shows `runtimeAlive: false` and `workspaceExists: false`.
- Repeated `kill` on an already cleaned session is idempotent and does not rewrite metadata again.
- `get/list`: report `activity: active` while an agent is working inside the tmux pane.
- `get/list`: report `activity: ready` when the agent is back at a prompt and recently active.
- `get/list`: report `activity: idle` when the agent is still at a prompt after the 5 minute threshold.
- `get/list`: report `activity: waiting_input` when the pane tail shows a permission or confirmation prompt.
- `get/list`: prefer the current prompt over stale permission text still visible in recent pane history.
- `get/list`: report `activity: exited` when the tmux session or agent process is gone.
- `get/list` during `spawning`: report `activity: active` and keep `runtimeAlive` aligned with the actual tmux session state.

## Agents

- `claude`: starts with `--dangerously-skip-permissions` and answers the initial prompt.
- `codex`: starts with `--dangerously-bypass-approvals-and-sandbox` and answers the initial prompt.
- Both agents: answer a follow-up `send` message in the same session.

## Event Sources And Triggers

- `cron` source: validates `schedule`, starts on daemon boot, and emits its configured event.
- `runOnStart: true`: emits immediately on boot and reaches the matching trigger without manual CLI input.
- `runOnStart: false`: does not spawn early and creates the session only after the scheduled cron tick.
- `runOnStart` startup path: emits only after the daemon is listening and all configured sources are up, so a failed boot does not leave trigger-created session artifacts behind.
- `trigger -> spawn`: creates a normal Spur session, so `list/get/send/kill` work on triggered sessions too.
- Triggered sessions: still launch the requested agent with full access and the agent answers in tmux.

## Negative Paths

- Unknown project.
- Unsupported agent fails before session metadata, worktree, or tmux side effects.
- Empty prompt.
- Missing positional prompt for `spawn`.
- Empty branch.
- Missing session for `get`.
- Missing session for `kill`.
- Empty message for `send`.
- `cron` source without `schedule`.
- Trigger referencing an unknown source.

## Regression Rule

- When a new Spur feature is added, extend this file in the same change.
- For `v2/`-only changes, `$tester` must exercise the touched `spur` CLI commands and rerun the impacted scenarios.
- For touched `v2/` code, `$tester` also checks for hanging logic, stray fallbacks outside boundary/cleanup paths, and loose or bloated type shapes.
- `$tester` must rerun potentially affected existing scenarios and the new scenarios for that feature.
