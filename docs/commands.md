# Commands

CLI reference. Config fields live in [configuration.md](configuration.md).

## Surface

`init`, `update`, `doctor`, `gc`, `spawn`, `shepherd`, `list` (`ls`), `connect`, `disconnect`, `wake`, `send`, `queue`, `pause`, `complete`, `kill`, `respawn`, `reopen`, `handoff`, `session-memory`, `memory`, `actions`, `service`, `source`, `agent-issue`, `comment-seen`, `subscribe`. Internal and hidden from `--help`: `daemon start|stop|restart`, `slots`, `sidecar start|stop|sweep`, `self-destruct`, `branch`, `reinit`, `update-monitor`.

Run from source with `node v2/dist/cli.js <cmd>` after `pnpm --dir v2 build`.

`POST /deploy/switch` starts a detached install-and-restart helper and returns `202 { accepted: true, version }`. A second request while the helper is running returns `409 { error, inProgress: true, version }` for the active target, including after the daemon restarts. `GET /deploy/switch/status` returns the durable `running`, `succeeded`, or `failed` record; before any switch it returns `{ phase: "idle" }`.

## doctor

Read-only. Checks host install, config validity, and daemon/web health; exits non-zero on a broken (not merely un-initialized) host. Writes no config or state. `--scaffold` writes a minimal local `spur.yaml` at the repo root when none exists — it still does not start the daemon or create `~/.spur/config.yaml`. The global config and local project auto-connect on the first normal command. A `sidecar-orphans` check (`warn`) reports the same leaked trees as `spur sidecar sweep` — see [Sidecars](#sidecars) — without killing anything. The `config-registry` check also lists every registered path with its alive/dead/worktree-internal state, both in the human-readable output and in `--json` — see [Config registry](configuration.md#config-registry).

When the daemon is reachable, `doctor` also fetches `GET /headroom` and reports one `session-headroom` check: live session count vs. the [resolved admission cap](configuration.md#admission-control), followed by every live session id and its measured RSS. The `fix` names candidate session ids to stop once the cap is reached or the memory guard has crossed a threshold. This check is `warn` severity always — never `error` — so a full host never flips `doctor`'s exit code; it stays a surfaced fact, not a failure. Nothing is pushed when the daemon is unreachable (the daemon-reachable check already owns that fact).

## gc

```bash
spur gc [--execute] [--older-than <days>] [--statuses completed,killed,stopped] [--project <id>] [--limit <n>] [--no-sizes] [--json]
```

Reclaims stale session worktrees and moves terminal session records out of the daemon's 2s scan. Dry run unless `--execute`; prints every candidate group with age, size, and the action it would take. Daemon-free — reads the config and data dir directly, no running daemon needed.

Unit of collection is the workspace group, not the session: every session sharing a `workspaceId`, plus any group sharing an identical `worktreePath`. One non-eligible member blocks the whole group, so a live sibling protects a parked one.

Actions: `reclaim` removes the worktree, then archives the records; `archive` only moves records (worktree already gone, or the session ran in the project path); `blocked` does nothing and prints its reasons.

Blocked reasons: `not_eligible_status`, `too_recent`, `changed_during_run`, `path_outside_worktree_dir`, `shared_workspace_path`, `path_is_cwd_or_ancestor`, `uncommitted_changes`, `unpushed_commits`, `open_pr`, `probe_failed`. Every guard is re-checked immediately before removal, against a fresh record read — a probe that throws blocks, never passes. `changed_during_run` covers any change to the fields a guard reads: status, `updatedAt`, `worktree`, `worktreePath`, `branch`, PR binding.

Open-PR detection is one `gh pr list --repo <slug> --state open` per repo per run, matched against the stored `session.pr` number and the session branch. A saturated list is a block, not an empty result.

Worktrees go out through `git worktree remove` plus `git worktree prune`, so the parent repo's metadata stays consistent. Records move to `<dataDir>/sessions-archive/<projectId>/<sessionId>.json` with their log shard dir; `mv` one back into `<dataDir>/sessions/<projectId>/` to un-archive (the index self-heals). A collected `stopped` session can no longer be restored — `spur gc` lists those ids before it acts.

Worktree removal happens before archival. A group whose removal succeeded but whose archival failed reports `removed: true, archived: false` with an error; its record stays in `sessions/` pointing at a deleted path, and the next run collects it as `archive`. Nothing to do by hand.

Freed bytes come from `du -s --block-size=1` measured before removal. A file hardlinked into several worktrees (pnpm store) counts once per worktree, so a large total can overstate the disk actually returned. `--no-sizes` skips measurement (no freed-byte reporting). Exits `1` when any group errored during `--execute`.

Defaults come from `sessionGc.*` ([configuration.md](configuration.md#field-reference)); `--limit` defaults to `100`. The daemon runs the same policy on a timer when `sessionGc.enabled` is `true`.

## daemon

`daemon start|stop|restart --config <path>` each refuse instead of bootstrapping when `<path>` (or `SPUR_CONFIG`) does not exist and is not the default `~/.spur/config.yaml`; only the default path bootstraps a fresh config on first boot. All three verbs also refuse a non-default `<path>` that already exists but claims the production slot (`server.port` `4310`, or `dataDir` `~/.spur`, either explicit or inherited by omitting the field) — this check is read-only and never writes the rejected config. A default-path config is always exempt, whether it exists yet or not, so first boot and restart of the real daemon are unaffected. Use `scripts/spur-isolated-daemon.sh` for a throwaway verification daemon instead of pointing `--config` at an ad hoc path with prod-shaped `port`/`dataDir`.

Spur keeps a durable config registry in `dataDir`: any normal CLI command syncs its `--config` into the daemon, and daemon boot reloads every registered path, rehydrates session state, resumes pipelines, and restarts sources/triggers. Attached configs must agree on `server.host`, `server.port`, `dataDir`, and `worktreeDir`; their project ids and `sessionPrefix` values stay globally unique per daemon.

The `agent-process-ownership` check reports live agent processes their session record does not own. Ownership keys on the `SPUR_SESSION` id each process carries, never on cwd — the worktree in a finding is evidence, not the key. Reasons: `duplicate_for_session` (live record, more than one process), `terminal_record` (record `completed` or `killed`), `unknown_session` (no record). Each finding prints pid, agent, session id, reason, rss, age, worktree. Severity `warn`, so findings never flip the exit code. Linux only (reads `/proc/<pid>/environ`); elsewhere the check reports `cannot determine agent process ownership on this platform` at `info`. Skipped when `~/.spur/config.yaml` is absent or unparsable.

## spawn

```bash
spur spawn <project> [prompt...] [--agent claude|codex|cursor] [--model <id>] [--mode <name>] [--plan] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared] [--subscribe-to <sessionId> --subscribe-state <state> ... [--subscribe-message <message>]]
```

Takes a task prompt, or starts an empty agent session. Optional `steps` are a pipeline skeleton around the task.

- `[prompt...]` optional. Empty opens the session without an initial message and skips default `spawn.steps`.
- `--step <label>` appends a manual pipeline phase; repeat for more.
- `--plan` enables plan-mode startup, disables configured/manual steps, and appends a planning-only instruction. Claude adds `--permission-mode plan`; Cursor uses `--plan`; Codex accepts the flag with launch behavior unchanged.
- `--model <id>` applies to the resolved agent on fresh launch. Ids come from claude aliases (opus/sonnet/haiku/fable), Codex `models_cache.json` under configured `models.codexHome`, or `cursor models`.
- `--mode <name>` picks a session mode from `projects.<id>.modes`, overriding the project default. Unknown name fails the spawn. See [Modes](configuration.md#modes).
- `--subscribe-to <sessionId>` arms one state subscription on the new session before spawn returns, watching `<sessionId>`; requires at least one `--subscribe-state`. `--subscribe-state <state>` is repeatable; `--subscribe-message <message>` sets the delivered text. See [`subscribe`](#subscribe) for state names and delivery semantics.
- Spur sends the next phase only after the agent returns to its prompt, then waits 30s before auto-sending.
- Project configs set default `spawn.steps`; manual/API/trigger steps override.

```bash
spur spawn backend-api "Fix the flaky auth test"
spur spawn backend-api "Fix the flaky auth test" --step research --step test
spur spawn backend-api
```

Agents launch with full access: `claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`.

Preflight is opt-in. When `projects.<id>.preflight` is set and `spawn` gets no `--branch`, Spur asks the agent for exactly one line before worktree creation: a branch name or `NO_PROJECT_RULES`. Only the exact sentinel bypasses fallback `branchNaming` validation. Empty, malformed, failed, invalid, or checked-out results retry three times, then fail the spawn. Explicit `--branch` stays strict and rejects a conflict with the conflicting worktree path.

New worktree branches fetch `origin`, fast-forward the base branch when only behind, and branch from the freshest remote ref. Override the base per session with `--worktree <defaultBranch>`.

## shepherd, wake

```bash
spur shepherd [prompt...]
spur wake <sessionId> --in 10m [message...]
spur wake <sessionId> --at <iso-time> [message...]
spur wake <sessionId> --daily-at 09:00,17:00 --until "done condition" [message...]
```

`shepherd` opens Spur's built-in manager session: `Shepherd` project, Claude in shared workspace, orchestration-only prompt (inspect state, use `$manager`, coordinate agents, no product code unless the operator asks for a config edit). Its workspace is re-created if missing, on `send` or `restore`.

`POST /shepherd/spawn` reuses the newest running or spawning Shepherd. Pass `reportDisposition: true` to receive `{ disposition: "spawned" | "reused", session }`; omit it for the legacy session-only response.

`wake` stores a delayed or recurring message; the daemon delivers when due, so a session can schedule its own next check. Daily wakes use daemon-local `HH:MM` and require `--until`. Each due occurrence is attempted once: a one-shot wake is consumed either way, and a failed daily occurrence skips straight to its next scheduled time instead of retrying. Delivery goes through the normal queued `send` path, so a synchronous failure (session gone, not running) logs `session.wake.failed` / `session.wake.daily_failed` as before, but a pane-write failure after the message is queued no longer counts as that wake failing — it logs `session.wake.sent` / `session.wake.daily_sent` and the message retries through the queue drain (below) like any other queued message.

## list

TTY opens a live selector: `Enter` attach in place, `l` log view, `p` pause, `c` complete, `r` restore, `k` kill, `Esc` quit. `Ctrl+G` returns to the selector. Non-TTY prints a one-shot summary.

Hides `completed` and `killed` by default. Derives live `state` and `lastActivityAt` from `tmux` plus native Claude/Codex signals. The log view combines key session events with a live tail of the main agent pane.

A session with one or more sidecars whose age is resolvable shows a compact `sidecar <name> <age>` fact, naming only the oldest sidecar (`+N more` when others are running); a `!` suffix marks one already past `sidecarGc.maxAgeWarnMinutes` ([Sidecar reaping](configuration.md#sidecar-reaping)). A session with no sidecars, or none with a resolvable age, renders unchanged.

`pause` keeps the worktree. `complete` and `kill` both tear down the pane and remove an owned worktree; `kill` additionally requires `--force` on a dirty or unpushed worktree. Shared-workspace sessions keep the project path on `kill`. `restore` needs status `running`, `stopped`, or `paused` with state `stopped`/`error` — or status `errored` with state `error` — plus an existing workspace (shepherd excepted, see above), so `killed` and `completed` sessions are never restorable.

`restore` and `reopen` refuse to launch over a live agent process still carrying that session id: a foreign process outside the pane, or the pane's own process surviving the SIGHUP, SIGTERM, SIGKILL escalation (2s grace per signal). They also refuse when the process table could not be read at all, since "no survivors" would then be a guess; a teardown with no relaunch behind it (`pause`, `complete`, `kill`) proceeds instead of refusing. A first `r` surfaces the refusal; a second `r` on the same session retries with force, which bypasses the foreign-process refusal only — a SIGKILL survivor and an unreadable process table refuse either way. `spur reopen <sessionId> --force` is the CLI equivalent. The foreign-process scan reads `/proc/<pid>/environ`, so off Linux it is skipped, not failed, and it is also skipped when the pane's own pid is unreadable, because the scan cannot then tell the session's own agent from a foreign one.

`reopen <sessionId>` restarts a `completed` session in place — same id, same worktree path, native conversation resumed, original prompt not resent; it refuses when the branch is gone (use `respawn`), when the stored worktree path isn't the session's own (e.g. a desk anchor's) or the rebuild fails, or when a reopen for that session is already running; does not bring back the Telegram binding or session artifacts; MCP sidecars restart through the restore path.

While an agent is busy, manual `send` queues per session and flushes when it returns to a prompt, ahead of the next auto-step. For a `stopped`/`paused` session with an existing workspace (shepherd excepted, see above), `send` first tries to resume the native Claude/Codex conversation, then falls back to a fresh launch.

```bash
spur queue <sessionId> list [--json]
spur queue <sessionId> remove <index> [--json]
spur queue <sessionId> flush <index> [--json]
```

One session's message queue. `list` numbers real queued messages from `1`; a pipeline's own future steps print separately, unnumbered, and are never a `remove`/`flush` target. `remove`/`flush` take that number, resolve it to exact message text through a fresh read taken immediately before acting, and echo the resolved text. The queue moves on its own, so a number from an older `list` either fails as not queued or acts on whatever now sits at that position. `remove` drops the message unsent. `flush` sends it immediately, ahead of the rest of the queue, which stays queued; it fails `409` while a pane write for that session is already in flight (the queue drain, or another flush) instead of holding the command for an ack window. `remove` fails the same `409` only when the targeted message is currently the queue's head and a delivery is in flight for it — the pane write may have already landed, so reporting a plain removal would be a lie; removing any other position is never in flight (only the head is ever mid-delivery) and always succeeds.

Both act through `POST /sessions/:id/queue/remove` and `POST /sessions/:id/queue/flush`, body `{"message": "<exact queued text>"}` — content-keyed, no index over the wire, matched against the trimmed value on both sides since a queued message is always trimmed at enqueue; `404` when that text is not queued. The web session view drives the same two routes from per-row send-now and delete icons; auto steps get no controls.

Queued-message delivery events: `session.message.sent` (delivered), `session.message.delivery_recovered` (the agent's submit acknowledgment timed out but the process was still alive, so the pane write is treated as delivered), `session.message.delivery_failed` (retained, retried on the next poll), `session.message.queue_removed` (a `remove` call). A landed delivery logs exactly one of `sent` / `delivery_recovered` / `delivery_failed`; a `delivery_failed` whose message is unchanged from the last logged failure on that session is suppressed (zero events) rather than repeated once per poll, so a permanently broken session doesn't flood the log.

Spur appends lifecycle events to `<dataDir>/events.jsonl` (recover checks, native-resume failures, fresh-launch fallbacks, step delivery). GitHub poll-cost events:

- `gh.poll_cycle`: one completed poll cycle; includes `calls` and `graphqlCost`.
- `gh.usage`: minute/hour `gh` invocation and GraphQL-cost windows.
- `gh.poll_budget_paused`: polling skipped to preserve the shared GraphQL reserve; includes remaining budget and reset time when known.

GitHub source cadence, including `adaptivePoll`, lives in [Configuration](configuration.md#field-reference).

## connect, disconnect

```bash
spur connect [path]
spur disconnect [path]
```

Register or unregister a project config with the running instance. `[path]` resolves against the cwd; omitted, Spur takes the nearest `spur.yaml`/`spur.yml`. What the daemon accepts: [config registry](configuration.md#config-registry).

## spur-slots

On each live session's `PATH`. Updates the tmux status-line title and named links stored with the session:

```bash
spur-slots --title-if-absent "Fix flaky auth test"
spur-slots --link pr=https://github.com/org/repo/pull/45 --link tracker=https://tracker.example.com/TASK-123
```

`--title-if-absent` initializes the workspace title once. Later conditional writes do nothing. `--title` and `--clear-title` remain unrestricted manual controls; either blocks future conditional title writes in that workspace. Other flags combined with a blocked conditional title still apply.

## service

Each live session gets a `spur` wrapper on `PATH`, bound to that session's config, for session-bound sidecars:

```bash
spur service run web --port 3000 -- pnpm dev
spur service logs
spur service status api-a1b2
```

`service run` reads `SPUR_SESSION`, starts the command in a separate tmux sidecar, and stores metadata under the data dir. Stop/restart is not managed yet — the service stays bound while the session is alive. Pass `--port` so `list` can surface it. Sidecar/service output also lands in the session event log for `spur service logs` and `/sessions/:id/logs`.

## memory

```bash
spur memory set|get|list|rm [key] [body] --scope task|project|global [--session <id>] [--file <path>] [--json]
```

Shared markdown memory: one `.md` file per key, body only, no tags/status/timestamps. `set` creates or overwrites. `list`/`get`/`rm` read or remove. Session id defaults to `SPUR_SESSION`; pass `--session` from outside a live session. `set` takes the body positional or `--file <path>` for multiline content — never both, never neither.

Scopes resolve server-side from the caller's session, never from client input:

- `task` — `<dataDir>/memory/task/<workspaceId>/<key>.md`, shared across every session in the same workspace.
- `project` — `<dataDir>/memory/project/<projectId>/<key>.md`, shared across all sessions of a project.
- `global` — `<dataDir>/memory/global/<key>.md`, one cell set for the whole Spur instance.

Writes are atomic (tmp file + rename) but unlocked — concurrent `set` on the same key is last-writer-wins.

Spawn prompt tells agents to read `task`/`project` on start and write durable, high-value facts only (business decisions, gotchas, user preferences) — not scratch, logs, or restated docs.

## subscribe

```bash
spur subscribe <targetSessionId> --state <state> [--state <state> ...] [--message <text>] [--session <id>]
spur subscribe --list [--session <id>]
spur subscribe --remove <subscriptionId> [--session <id>]
```

Watches another session's state and sends the subscriber a message on a matching transition. Subscriber session defaults to `SPUR_SESSION`; pass `--session` from outside a live session.

One subscription per target: `id` is `state-<targetSessionId>`. Re-subscribing to the same target overwrites its states and message. Cannot subscribe to yourself.

`--state` is repeatable. Valid states: `working`, `waiting`, `needs_input`, `rate_limited`, `stopped`, `error`, `killed`. Delivery fires once per matching transition, immediately after the target session's state settles — not on every poll. If the target is already in a watched state when the subscription arms, nothing fires until the next transition into that state. `--message` sets custom text appended after a blank line to the default `Session <targetSessionId> changed state: <from> -> <to> at <iso> (source: <src>).` line.

Delivery goes through the normal queued `send` path: a `stopped`/`paused` subscriber gets resumed (native conversation resume, then fresh launch fallback) to receive it. There is no retry of the dispatch itself — it fires once per transition. The transition is claimed as soon as `send` queues the message, not once it is actually delivered: a synchronous `send` failure (subscriber gone, not running) logs `session.subscription.delivery_failed` and leaves the transition unclaimed so a later matching transition can retry it; a pane-write failure after the message is queued does not — the transition stays claimed and the message itself retries through the message-queue events above.

`spur spawn --subscribe-to/--subscribe-state/--subscribe-message` arms one subscription at spawn time — same target/state/message rules above. The CLI checks the target session exists before spawning and fails with a clear error if it doesn't. Direct API/MCP callers that skip this check get the daemon's own non-fatal behavior instead: an invalid spawn-time target doesn't fail the spawn — Spur logs `session.subscription.spawn_failed` and the new session comes up with no subscription armed.

## Sidecars

For repo testing prefer `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>` over direct `pnpm dev` / `next dev`. It starts a configured sidecar from `projects.<id>.sidecars`. In this repo, `isolated-daemon` starts an isolated Spur daemon and `isolated-ui` starts the web UI against it, publishing a `sidecar-ui` link. `isolated-ui` uses its own Next `distDir` so its cache stays isolated from normal `packages/web` runs. New isolated worktrees inherit the current `spur.yaml`, agent instructions, and `.env` via the config overlay plus symlinks.

`autoStart` applies when the main session spawns, restores, or recovers a dead agent — a session whose pane comes back gets its `autoStart` sidecars back too. Starting a sidecar from inside a sidecar is always manual, and nesting stops after one level (`session -> sidecar -> nested sidecar`). Nested sidecars never auto-start.

Sidecar `ports` are reserved and probed on the host at start and injected into the sidecar env, so siblings and unrelated processes cannot race the range.

A non-MCP sidecar is desk-shared: one tmux pane and port set for the whole [desk group](configuration.md#desk-groups), started and stopped from any member.

Commands run through `sh -lc` with no `exec`, so login-shell init still applies and a sidecar command may start with `VAR=value ...`. `/bin/sh` is `dash` on Debian/Ubuntu, so `source` and nvm's own bashisms are unavailable inline — invoke `bash` explicitly for anything that needs nvm, e.g. a `bash`-shebang script or `bash -lc '. "$SPUR_REAL_HOME/.nvm/nvm.sh" && nvm use <v> && ...'`. If the launching agent's sandbox remaps `$HOME` to a scratch dir, the sidecar inherits it — use `$SPUR_REAL_HOME` (resolved from `/etc/passwd`) to reach the real home.

Sidecars, project services, and the Claude OAuth login pane do NOT inherit the agent session's npm prefix pin (`NPM_CONFIG_PREFIX`/`npm_config_prefix`/`NPM_CONFIG_GLOBALCONFIG`/`npm_config_globalconfig`/`PREFIX` are all stripped) so they can source `~/.nvm/nvm.sh` without tripping nvm's own incompatibility guards. A sidecar's own `npm run`/`npx` invocations still re-export `npm_config_prefix` to their children regardless (vanilla npm behavior), which can trip nvm one level down inside those children.

Stop and restart reap the sidecar's whole tmux pane process tree, not just the pane's direct child — a supervisor (nodemon, tsx watch) that `setsid`s a worker into its own process group no longer leaves that worker behind. `spur sidecar sweep` reports sidecar process trees no live session claims (pid, rss, age, worktree); nothing is killed unless you pass `--reap`.

The daemon also reaps idle sidecars on its own policy, and refuses to start a duplicate one across workspaces — see [Sidecar reaping](configuration.md#sidecar-reaping).

### Built-in MCP sidecars

A sidecar entry can carry MCP wiring, injecting its reserved port into the launching agent's MCP
config (claude `mcp-config.json`, codex `config.toml [mcp_servers.*]`) before launch. `playwright`
is the one built-in: a Spur-owned HTTP playwright MCP sidecar (headless browser tooling) for
claude/codex sessions, never cursor, off by default. Opt a project in with:

```yaml
sidecars:
  playwright:
    autoStart: true
```

Command, ports, and MCP wiring are code-only defaults (see `v2/src/sidecars/`); YAML only overrides
`autoStart` — a built-in entry rejects any other key, including `dependsOn`: MCP sidecars start
before the agent launches, ahead of the dependency-aware autostart pass, so a dependency on it
could never be satisfied. Enablement re-resolves from config at every spawn/restore/recover — no
per-session toggle, no `spur playwright` command.

Enabling an MCP sidecar for claude changes MCP resolution for the whole session: claude launches
with `--mcp-config <path> --strict-mcp-config`, so only servers Spur pre-merged into that generated
config survive — the merge reads `~/.claude.json` user-scope servers, `~/.claude.json`
`projects["<worktree path>"]`, and `<worktree>/.mcp.json`. A fresh worktree has no
`projects["<worktree path>"]` entry yet, so local-scope servers approved against the main repo path
are dropped for that session. A host `mcpServers.playwright` entry (from any of those three sources)
is silently replaced by Spur's own.

## build

```bash
pnpm --dir v2 build
```

`build` also restarts a running daemon when Spur config is discoverable. A normal CLI command auto-connects its discovered project config into the daemon; registration and pruning rules live in [config registry](configuration.md#config-registry). Attached configs must agree on `server.host`, `server.port`, `dataDir`, and `worktreeDir`; their project ids and `sessionPrefix` values stay globally unique per daemon.

## Validate

```bash
pnpm --dir v2 test            # fast (mocked, in-process)
pnpm --dir v2 test:runtime    # runtime integration (CLI, tmux, worktree, process boundaries)
pnpm --dir v2 test:smoke      # real-agent smoke against this repo (skips if tmux/binaries/auth missing)
```

Run `test:runtime` when touching CLI, daemon, transport, session lifecycle, worktree, or tmux. Run `test:smoke` when touching agent launch or prompt delivery.
