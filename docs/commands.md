# Commands

CLI reference: what to run, what it does, what `--help` skips. Config fields: [configuration.md](configuration.md). Daemon HTTP routes: [daemon-api.md](daemon-api.md).

## Surface

Hidden from `--help`: `daemon start|stop|restart`, `slots`, `sidecar start|stop|ports|sweep`, `self-destruct`, `branch`, `reinit`, `update-monitor`.

## Session tools and environment

`$SPUR_SESSION_TOOL_DIR` on `PATH`, holding session-bound wrappers:

- `spur`, `spur-slots`, `spur-sidecar`, `spur-self-destruct`, `spur-todo`.
- `branchNaming.regex` adds `spur-branch` and a push-checking `git` wrapper.
- Hook-state agents also get `spur-agent-state`.
- `isolated-daemon`/`isolated-ui` sidecars add `spur-isolated`, a CLI wrapper bound to the throwaway isolated daemon; the plain `spur` wrapper still targets the real daemon.
- Call each by its explicit `"$SPUR_SESSION_TOOL_DIR/<tool>"` path — login shells rebuild `PATH`, drop the tool dir.
- Identity: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SESSION_TOOL_DIR`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_REAL_HOME`.
- Commands: `$SPUR_SLOT_COMMAND`, `$SPUR_TODO_COMMAND`; hook-state agents add `$SPUR_AGENT_STATE_COMMAND`, `$SPUR_AGENT_STATE_FILE`.

## doctor

Read-only: checks host install, config, daemon/web health; exits non-zero only on a broken host. `--scaffold` writes a minimal local `spur.yaml` when missing, no daemon start, no `~/.spur/config.yaml` write.

- `sidecar-orphans` (warn) — leaked trees `sidecar sweep` reaps, report-only.
- `config-registry` (info) — every registered path, alive/dead/worktree-internal state.
- `session-headroom` (warn, daemon up) — live count vs [cap](configuration.md#admission-control), id+RSS, `fix` names ids to stop.
- `home-disk-headroom` (warn/info) — `$HOME` space under [`diskRetention.warnFreeGb`](configuration.md), default 10GB.
- `reclaimable-caches` (info) — reclaimable total, top 5 prunable, one row/cache root.
- `claude-onboarding` (warn) — authenticated, never onboarded; first `spawn` hits the OAuth screen; fix: run `claude` once.
- `opencode-executable` (warn) — missing from PATH/`SPUR_OPENCODE_BIN`; fix: install `opencode-ai` or set [override](configuration.md#field-reference).
- `skills-symlinks` (warn) — skill link state under `~/.claude/skills`/`~/.codex/skills`; never creates a dir/link; `fix` names a conflicting path before `spur reinit`.
- `agent-process-ownership` (warn, Linux) — live agent processes their record doesn't own: `duplicate_for_session`, `terminal_record`, `unknown_session`, `foreign_instance` (info). Prints pid/agent/session/reason/rss/age.

## gc

`spur gc [--execute]` reclaims stale worktrees, archives terminal session records. Dry run unless `--execute`, daemon-free. Unit: workspace group — sessions sharing a `workspaceId` or `worktreePath`; one non-eligible member blocks the group.

Actions: `reclaim` removes worktree, archives; `archive` moves records only; `blocked` prints reasons: `not_eligible_status`, `too_recent`, `changed_during_run`, `path_outside_worktree_dir`, `shared_workspace_path`, `path_is_cwd_or_ancestor`, `uncommitted_changes`, `unpushed_commits`, `open_pr`, `probe_failed`.

Records move to `<dataDir>/sessions-archive/<projectId>/<sessionId>.json` with their log shard; `mv` back into `sessions/<projectId>/` to un-archive (a collected `stopped` session can't restore — `gc` lists those ids first). `--no-sizes` skips freed-byte measurement; exits `1` on any group error. Defaults: `sessionGc.*` ([configuration.md](configuration.md#field-reference)), `--limit` `100`.

## cache

`spur cache [--prune --yes]` reports host caches outside `~/.spur` — size, path, age (days), protection reason per entry, size-ranked. Dry-run by default; `--prune --yes` deletes `prunable` entries, no daemon needed. Covers `~/.npm/_cacache`, `~/.npm/_npx`, `~/.cache/ms-playwright(-mcp)`, rest of `~/.cache`, `/tmp`, never `~/.spur`.

Prunable: `vendor-cache` (`~/.npm/_cacache`) — 7d, protected while npm/pnpm/npx/yarn runs. `npx-package` (`~/.npm/_npx/<hash>`) — 30d, protected by a `browsers.json` pin or live-process argv match. `browser-revision` (`~/.cache/ms-playwright/<name>-<rev>`) — 30d, protected by any resolved `browsers.json` pin, fail-closed if none resolve. Report-only: `browser-profile` (`mcp-*` dirs, cookies), `browser-registry` (`~/.cache/ms-playwright/b`), `generic` (rest of `~/.cache`), `tmp-entry` (`/tmp`). Unreadable process tree degrades plan to report-only.

## daemon

`daemon start|stop|restart --config <path>` refuses to bootstrap when `<path>` (or `SPUR_CONFIG`) doesn't exist and isn't the default `~/.spur/config.yaml` — only the default path bootstraps first boot. All three refuse a non-default `<path>` claiming the production slot (`server.port` `4310` or `dataDir` `~/.spur`, explicit/inherited); read-only check.

Any CLI command syncs its `--config` into the daemon's durable registry. Attached configs must agree on `server.host`, `server.port`, `dataDir`, `worktreeDir`; project ids/`sessionPrefix` stay globally unique per daemon. Registry mechanics: [config registry](configuration.md#config-registry).

## spawn

```bash
spur spawn <project> [prompt...] [--agent claude|codex|cursor|opencode] [--model <id>] [--mode <name>] [--plan] [--restrict-writes] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared] [--subscribe-to <sessionId> ...]
```

Empty `[prompt...]` skips default `spawn.steps`. Spur sends the next phase after the agent returns to prompt, waits 30s before auto-send. Project configs set default `spawn.steps`; manual/API/trigger override.

`--model <id>` ids: claude aliases (opus/sonnet/haiku/fable), Codex `models_cache.json` under `models.codexHome`, `cursor models`, `opencode models`. `--subscribe-to`/`--subscribe-state`/`--subscribe-message` arm one subscription at spawn, see [subscribe](#subscribe). See [Modes](configuration.md#modes).

Full-access launch: `claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `opencode --auto` (>= 1.18.18). Spur resumes `ses_...` ids via `opencode --session`, reads state/conversation via `opencode export`. OpenCode `restrictWrites` (config field, not the flag above) denies edit tools, `git commit`/push.

Preflight (`projects.<id>.preflight`, no `--branch`): Spur asks the agent for one line before worktree creation — a branch name or sentinel `NO_PROJECT_RULES`. Empty/malformed/checked-out results retry 3x, fail spawn. New worktree branches fetch `origin`, branch from freshest remote ref; `--worktree <defaultBranch>` overrides base.

## shepherd, wake

`spur shepherd [prompt...]`. `spur wake <sessionId> [--in <duration> | --at <iso> | --every <duration> --until <cond> | --daily-at HH:MM[,HH:MM...] --until <cond> | --cancel] [message...]`.

`shepherd` opens Spur's built-in manager session: `Shepherd` project, Claude, shared workspace, orchestration-only prompt; re-creates on `send`/`restore` if missing.

`wake` stores a delayed or recurring message, delivered when due. Daily wakes use daemon-local `HH:MM`; daily and `--every` both require `--until`. `--cancel` drops a recurring wake, exclusive with scheduling options. Each occurrence fires once: a synchronous failure fails the wake, a queued pane-write failure retries via the queue instead. Event names: [configuration.md](configuration.md#events).

Fires only while status is restorable (`running`, `stopped`, `paused`); dropped once `killed`. `errored`/`completed` stay armed but silent until `restore`/`reopen`, then fire one catch-up wake — same for an unrecoverable-but-restorable session. Admission refusal: [Admission control](configuration.md#admission-control).

## list

TTY opens a live selector: `Enter` attach, `l` log, `p` pause, `c` complete, `r` restore, `k` kill, `Esc` quit, `Ctrl+G` back. The selected session's details pane shows a `queued <N>` field when it holds real queued messages, never a per-row column. Non-TTY prints a one-shot summary, hides `completed`/`killed` by default, and adds a `queued <N>` fact beside the sidecar-age fact for a session holding real queued messages. Neither surface counts a pipeline's own auto-steps. A resolvable-age sidecar shows `sidecar <name> <age>` (oldest, `+N more`); `!` marks one past [`sidecarGc.maxAgeWarnMinutes`](configuration.md#sidecar-reaping).

`spur list --json` (and the non-TTY list row set) comes from `GET /sessions` — the projected list item ([daemon-api.md](daemon-api.md#session-routes)). The interactive selector's details pane (`prompt`/`launch` rows) fetches the full record from `GET /sessions/:id` for the currently selected session, on selection change and on each 2s refresh tick — the pane shows a loading line until that fetch resolves.

`pause` keeps the worktree; `complete`/`kill` tear down the pane, remove an owned worktree (`kill` needs `--force` on dirty/unpushed). Both check for an open PR first: `--pr-action leave_open|close` answers it, `--skip-pr-check` skips it; a failed check fails with retry hint. Shared-workspace sessions keep the project path on `kill`.

`spur restore <sessionId> [--force] [--json]` needs an existing workspace plus: `running`+state `stopped`; `stopped`+state `stopped`/`error`/`stale`; `paused`+state `stopped`/`error`; `errored`+state `error` (`killed`/`completed` never restore). `restore`/`reopen` refuse over a live agent process still carrying the id, or an unreadable process table (skipped off Linux); a first `r` surfaces refusal, a second `r`/`--force` bypasses only the foreign-process refusal. `restore` resumes the session's existing conversation.

`spur reopen <sessionId> [--force] [--json]` restarts a `completed` session in place — same id/worktree, native conversation resumed, prompt not resent. Refuses if branch is gone (use `respawn`), worktree isn't the session's own or its rebuild fails, or a reopen for that session is already running; skips Telegram binding and artifacts; MCP sidecars restart through restore. `respawn <sessionId>` starts a fresh session with a new id instead — the conversation is not carried over.

## todo

`spur todo list|add|complete|cancel|hold|resume --session <id> [<itemId>] [--text <text>] [--reason <reason>] [--human-action <action>]`.

Each session's ToDo ledger starts empty — no code path seeds an item; the agent adds one per step, right before it, and resolves it right after. `add`/`complete`/`cancel`/`hold` require a reason; `--human-action` records a human blocker; `resume` reopens held work; no delete. A human can also `add` through the CLI or session-detail UI. An empty ledger, and open or held work, both block a session closing itself: completion, self-destruct, handoff, trigger+desk completion. The block is on the agent only — a `complete` or `handoff` a person issues from the CLI or the UI, with no session acting on its own behalf, goes through whatever the ledger holds.

`$SPUR_TODO_COMMAND`: session-bound `spur-todo` wrapper, same actions, no `--session`, can't target another ledger. Routes/error codes: [daemon-api.md](daemon-api.md#session-routes).

## send, queue

`spur send <sessionId> <message>`. While an agent is busy, `send` queues per session, flushes on return to prompt, ahead of the next auto-step. Prints `Delivered message to <id>.` when the response carries no real queued messages, `Queued message for <id> (<N> pending).` otherwise; N counts real queued messages, never a pipeline's own auto-steps. A `stopped`/`paused` session with an existing workspace: `send` tries native resume first, then a fresh launch.

`spur queue <sessionId> list|remove|flush [index]`. `list` numbers real queued messages from `1`; a pipeline's own future steps print unnumbered, never a target. `remove`/`flush` resolve that number to exact text just before acting; `remove` drops it unsent, `flush` sends it immediately, ahead of the queue. `flush` fails `409` while any pane write for that session is in flight. `remove` fails `409` only when the target is the queue head and its delivery is in flight; any other position always succeeds. Wire: [daemon-api.md](daemon-api.md#session-routes).

Delivery, wake, and lifecycle event names: [configuration.md](configuration.md#events). Lifecycle events land in `<dataDir>/events.jsonl`; retention: [configuration.md](configuration.md#event-log-retention).

## connect, disconnect

`spur connect [path]` / `spur disconnect [path]` register or unregister a project config with the running instance. `[path]` resolves against cwd; omitted, Spur takes the nearest `spur.yaml`/`spur.yml`. Accepted configs: [config registry](configuration.md#config-registry).

## spur-slots

On each live session's `PATH`. Updates the tmux status-line title and named links stored with the session: `spur-slots --title-if-absent "Fix flaky auth test"`, `spur-slots --link pr=<url> --link tracker=<url>`.

`--title-if-absent` sets the title once; later conditional writes no-op. `--title`/`--clear-title` are unrestricted manual controls; either blocks future conditional writes for that workspace.

## service

Each live session gets a `spur` wrapper on `PATH`, bound to that session's config, for session-bound sidecars: `spur service run web --port 3000 -- <command>`, `spur service logs`, `spur service status <id>`.

`service run` reads `SPUR_SESSION`, starts the command in a separate tmux sidecar. No stop or restart — stays bound while the session is alive. Pass `--port` so `list` can surface it. Output also lands in the session event log for `service logs`/`/sessions/:id/logs`.

## memory

`spur memory set|get|list|rm [key] [body] --scope task|project|global`. One `.md` file per key, body only. `set` creates or overwrites; `list`/`get`/`rm` read or remove. Session id defaults to `SPUR_SESSION`; pass `--session` outside a live session. `set` takes the body positional or `--file <path>` — never both/neither. Writes are atomic, unlocked — concurrent `set` on the same key is last-writer-wins.

Scopes resolve server-side from the caller's session, never from client input: `task` (`<dataDir>/memory/task/<workspaceId>/<key>.md`, per workspace), `project` (`<dataDir>/memory/project/<projectId>/<key>.md`, per project), `global` (`<dataDir>/memory/global/<key>.md`, one per instance). Spawn prompt tells agents to read `task`/`project` on start, write durable, high-value facts only.

## subscribe

`spur subscribe <targetSessionId> --state <state>... [--message <text>] [--session <id>] | --list | --remove <subscriptionId>`.

Watches another session's state, sends the subscriber a message on a matching transition. Subscriber defaults to `SPUR_SESSION`. One subscription per target (`id` = `state-<targetSessionId>`); re-subscribing overwrites states/message; no self-subscribe. `--state` repeatable, valid: `working`, `waiting`, `needs_input`, `rate_limited`, `stale`, `stopped`, `error`, `killed`. Fires once per matching transition, right after it settles — already-in-state at subscribe fires nothing until next transition. Default message: `Session <targetSessionId> changed state: <from> -> <to> at <iso> (source: <src>).`; `--message` appends after it.

A `stopped`/`paused` subscriber resumes to receive delivery (native resume, then fresh launch), no retry of the dispatch. A sync `send` failure logs `session.subscription.delivery_failed`, leaves the transition unclaimed for retry; a pane-write failure after queuing keeps it claimed, retries via message queue. `spur spawn --subscribe-to/--subscribe-state/--subscribe-message` arms one at spawn, same rules; CLI fails clearly if the target's missing. Direct API/MCP callers skip that check — an invalid target logs `session.subscription.spawn_failed`, comes up unsubscribed.

## Sidecars

Start `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, stop `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`, never bare — starts a configured sidecar from `projects.<id>.sidecars`. `autoStart` sidecars return on spawn, restore, or recover. A sidecar starting another is manual-only; nesting stops after one level.

Ports reserve/probe on the host at start, inject into the sidecar env only — pane env freezes first, no session variable carries it. Read with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports` (`--name <name>`, `--json`): `<sidecar> <portId> <env> <port> alive|dead` per line. A non-MCP sidecar is desk-shared: one tmux pane/port per [desk group](configuration.md#desk-groups).

Commands run through `sh -lc`, no `exec` — `/bin/sh` is `dash` on Debian/Ubuntu, nvm needs `bash -lc '. "$SPUR_REAL_HOME/.nvm/nvm.sh" && nvm use <v> && ...'`. A remapped `$HOME` still resolves via `$SPUR_REAL_HOME` (from `/etc/passwd`). A long-lived server should start its own command with `exec` — otherwise the pane pid is a shell above the real process, hiding it from pid/args-based reaping and leaving the shell holding unexpanded `$PORT` env.

Stop/restart reap the sidecar's whole tmux pane process tree, not just the direct child. `spur sidecar sweep` reports unclaimed process trees (pid, rss, age, worktree); nothing dies without `--reap`. A duplicate sidecar start across workspaces is refused. Daemon idle-reap: [Sidecar reaping](configuration.md#sidecar-reaping).

### Built-in MCP sidecars

A sidecar entry can carry MCP wiring, injecting its port into the launching agent's MCP config (claude `mcp-config.json`, codex `config.toml [mcp_servers.*]`) before launch. `playwright` is the one built-in: an HTTP playwright MCP sidecar for claude/codex, never cursor, off by default: `sidecars: { playwright: { autoStart: true } }`. YAML only overrides `autoStart`, rejects any other key incl. `dependsOn` (MCP sidecars start before the agent, ahead of the dependency-aware autostart pass). Re-resolved every spawn/restore/recover, no per-session toggle.

Enabling an MCP sidecar for claude changes MCP resolution for the whole session: claude launches
with `--mcp-config <path> --strict-mcp-config`, so only servers Spur pre-merged into that generated
config survive — the merge reads `~/.claude.json` user-scope servers, `<worktree>/.mcp.json`, and
`~/.claude.json` `projects["<worktree path>"]` (later wins). A fresh worktree has no
`projects["<worktree path>"]` entry yet, so local-scope servers approved against the main repo path
are dropped for that session. A host `mcpServers.playwright` entry (from any of those three sources)
is silently replaced by Spur's own. `~/.claude/settings.json` is not a source: claude ignores an
`mcpServers` block there, so merging it would start servers the session would otherwise not have.

### Suppressing a host MCP server

A globally-configured MCP server is spawned per session by the agent, whether or not the session
uses it. `projects.<id>.mcp.exclude` drops named servers from what Spur hands the agent, so a
project pays no RAM for tooling it does not need:

```yaml
projects:
  api:
    mcp:
      exclude: [playwright, digitalocean]
```

Applies to claude (dropped from the generated `mcp-config.json`, which is then launched with
`--strict-mcp-config`) and codex (the inherited `[mcp_servers.<name>]` table is stripped from the
session `config.toml`). Cursor has no suppression path. Excluding a name that a sidecar also binds
is safe: the sidecar wins, so `exclude: [playwright]` plus `sidecars.playwright.autoStart: true`
gives the session Spur's managed server and not the host's.

For claude, any non-empty `exclude` makes the generated config authoritative for the session, the
same as enabling an MCP sidecar — the caveats above apply. With no `exclude` and no MCP sidecar,
Spur passes no MCP flags and claude resolves servers itself.
