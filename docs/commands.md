# Commands

> Scope: CLI usage index, names and syntax only. Full behavior: `v2/src/cli.ts`, the command's own source file, or `spur <cmd> --help`. Config fields: [configuration.md](configuration.md). Daemon routes: [daemon-api.md](daemon-api.md).

Hidden from `--help`: `daemon start|stop|restart`, `slots`, `sidecar start|stop|ports|sweep`, `self-destruct`, `branch`, `reinit`, `update-monitor`. Global `--config <path>` (or `SPUR_CONFIG`) selects the instance config.

## Session tools and environment

`$SPUR_SESSION_TOOL_DIR` on `PATH`: `spur`, `spur-slots`, `spur-sidecar`, `spur-self-destruct`, `spur-todo` (+ `spur-branch`, `spur-agent-state`, `spur-isolated` when applicable). Identity env: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SESSION_TOOL_DIR`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_REAL_HOME`. Commands: `$SPUR_SLOT_COMMAND`, `$SPUR_TODO_COMMAND` (+ `$SPUR_AGENT_STATE_COMMAND`, `$SPUR_AGENT_STATE_FILE` for hook-state agents). `$SPUR_CLOSEOUT_OWNER=1` marks the closeout owner; `0` skips git/PR closeout in the Stop hook.

## doctor

Read-only host/config/daemon health check. `--scaffold` writes a minimal local `spur.yaml`. Checks: `sidecar-orphans`, `config-registry`, `session-headroom`, `home-disk-headroom`, `reclaimable-caches`, `claude-onboarding`, `opencode-executable`, `skills-symlinks`, `agent-process-ownership`.

## gc

`spur gc [--execute] [--older-than <days>] [--statuses <list>] [--project <id>] [--limit <n>] [--no-sizes] [--json]` reclaims stale worktrees, archives terminal session records. Defaults: `sessionGc.*` ([configuration.md#field-reference](configuration.md#field-reference)).

## disk

`spur disk [--json]` reports disk usage, writes `<dataDir>/disk-budget.json` ([disk budget](configuration.md#disk-budget)).

## disk-gc

`spur disk-gc [--execute --browser-revisions --older-than <days> --limit <n> --json]` reclaims stale playwright profiles and terminal-worktree build caches.

## artifacts-gc

`spur artifacts-gc [--execute --older-than <days> --max-bytes <bytes> --max-files <n> --project <id> --limit <n> --json]` prunes `agent-history-*.jsonl`. See [Artifact retention](configuration.md#artifact-retention).

## cache

`spur cache [--prune --yes]` reports/prunes host caches outside `~/.spur`.

## daemon

`daemon start|stop|restart`: `v2/src/cli.ts`; default instances with a systemd unit refuse detached auto-start/restart: `v2/src/client.ts`; registry: [config registry](configuration.md#config-registry).

## init

`spur init [--no-start] [--expose-web] [--web-port <port>] [--no-tailscale]` installs the `spur-daemon`/`spur-web` systemd user units and starts them. `--expose-web` binds the web UI to `0.0.0.0` instead of `127.0.0.1` (default port `5555`, `--web-port` overrides). `--no-tailscale` skips the Tailscale private-access setup. `init`, `update`, and `reinit` install Cursor's Spur token collector; malformed or unwritable hook config skips metering without blocking setup; the collector runs only in Spur sessions; Claude, Codex, and OpenCode use native structured usage.

## update

`spur update [version] [--force]`: install/monitor/rollback in `v2/src/update.ts`; daemon version/PID readiness in `v2/src/update-health.ts` (shared with `reinit`).

## spawn

`spur spawn <project> [prompt...] [--agent claude|codex|cursor|opencode] [--model <id>] [--mode <name>] [--plan] [--restrict-writes] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared] [--subscribe-to <sessionId> --subscribe-state <state> ... [--subscribe-message <text>]] [--json]`

Empty `[prompt...]` skips default `spawn.steps`. Preflight usage counts toward `projects.<id>.tokenBudget`. `--subscribe-state`/`--subscribe-message` require `--subscribe-to`. Modes: [configuration.md#modes](configuration.md#modes).

## shepherd, wake

`spur shepherd [prompt...]` opens Spur's manager session. `spur wake <sessionId> [--in <duration> | --at <iso> | --every <duration> --until <cond> | --daily-at HH:MM[,HH:MM...] --until <cond> | --cancel] [message...]`. Events: [configuration.md#events](configuration.md#events).

## list

`spur list [--json]` reads `GET /sessions` ([daemon-api.md#session-routes](daemon-api.md#session-routes)). TTY: live selector (`Enter` attach, `l` log, `p` pause, `c` complete, `r` restore, `k` kill).

`spur pause <sessionId> [--json]` — keeps the worktree.
`spur complete <sessionId> [--pr-action leave_open|close] [--skip-pr-check] [--json]`.
`spur kill <sessionId> [--force] [--pr-action leave_open|close] [--skip-pr-check] [--json]` — `--force` skips the dirty-worktree/unpushed-commit confirmation.
`spur restore <sessionId> [--force] [--json]`, `spur reopen <sessionId> [--force] [--json]` (in place, prompt not resent) — `--force` bypasses the foreign-live-process refusal; token-budget refusal: [configuration](configuration.md#field-reference).
`spur respawn <sessionId> [--force] [--json]` (fresh id, no carryover).
`spur handoff <sessionId> --agent <name> [--model <id>] [--notes <text>] [--json]` — hands off to another agent in the same workspace.

## todo

`spur todo list|add|complete|cancel|hold|resume --session <id> [<itemId>] [--text <text>] [--reason <reason>] [--human-action <action>]`. `$SPUR_TODO_COMMAND`: session-bound, no `--session`. Routes: [daemon-api.md#session-routes](daemon-api.md#session-routes).

## auto-ping

```
spur auto-ping unsubscribe --event <handle> [--session <id>] [--json]
spur auto-ping unsubscribe --thread <handle> [--session <id>] [--json]
spur auto-ping unsubscribe --subscription <handle> [--session <id>] [--json]
spur auto-ping list [--session <id>] [--json]
spur auto-ping resume <suppressionId> [--session <id>] [--json]
```

One scope flag required: `--event` (one occurrence), `--thread` (provider thread), `--subscription` (route). Unredeemed handles expire after 30d; `--event` suppression lasts 24h post-work. `SPUR_SESSION` supplies the target inside a session; else pass `--session`. Error `grant_not_ready` means retry.

Routes: [daemon-api.md#session-routes](daemon-api.md#session-routes). Source support: [configuration.md#events](configuration.md#events). Full rules: `v2/src/auto-ping.ts`.

## send, queue

`spur send <sessionId> <message>` refuses exhausted token budgets. `spur queue <sessionId> list|remove|flush [index]`. Wire: [daemon-api.md#session-routes](daemon-api.md#session-routes). Events: [configuration.md#events](configuration.md#events).

## connect, disconnect

`spur connect [path]` / `spur disconnect [path]`. Accepted configs: [config registry](configuration.md#config-registry).

## spur-slots

`spur-slots --title-if-absent "<title>"`, `spur-slots --link <label>=<url>`/`--unlink <label>`, `spur-slots --clear-title`, `spur-slots --tag <name>`/`--untag <name>`/`--list-tags` — session `PATH` helper for tmux title/links/tags.

`spur actions [--session <id> | --global] [--limit <n>] [--json]` — logged mutating requests, one session or fleet-wide.

## service, memory, agent-issue, comment-seen, subscribe

`spur service run <id> --port <n> -- <command>` / `status <id>` — session-bound tmux sidecar wrapper. `service logs [sessionId] [name] [--sidecar] [--limit <n>] [--json]` returns nothing today — no code path emits the `service.output`/`sidecar.output` events it filters on; read the tmux pane directly instead. `spur memory set|get|list|rm [key] [body] --scope task|project|global [--session <id>] [--file <path>] [--json]` — one `.md` file per key. `spur session-memory <sessionId> list|get|set|resolve [key] [body] [--json]` — [daemon-api.md#session-routes](daemon-api.md#session-routes).

`spur agent-issue log <text...>` / `list [--project <id>] [--session <id>] [--limit <n>] [--json]` — friction operating Spur itself, never a repo code defect.

`spur comment-seen record <id...>` — marks GitHub review-comment ids seen, needs `SPUR_PROJECT`.

`spur subscribe <targetSessionId> --state <state>... [--message <text>] [--session <id>] | --list | --remove <subscriptionId>`. States: `working|waiting|needs_input|rate_limited|stale|stopped|error|killed`.

## source reply

`spur source reply <message...> [--button <label[=value]>]... [--session <id>] [--json]` — agent-initiated send to the session's bound chat, `--button` repeatable up to 8 for inline choices. Text starts with the session label line (`<id> — <title>`); in a private chat a user reply to it routes back to this session. Wire: [daemon-api.md#session-routes](daemon-api.md#session-routes). Binding rules and formatting: [configuration.md#telegram-binding](configuration.md#telegram-binding).

## Sidecars

Start `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name> [--clear-port <port>]`, stop `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`. Ports: `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports [--name <name>] [--json]` — `<sidecar> <portId> <env> <port> alive|dead` per line. Sweep: `spur sidecar sweep [--reap]`. Idle-reap: [Sidecar reaping](configuration.md#sidecar-reaping). Outcomes: [daemon-api.md#session-routes](daemon-api.md#session-routes).

Commands run through `sh -lc` (`dash` on Debian/Ubuntu, no `nvm`); use `bash -lc '. "$SPUR_REAL_HOME/.nvm/nvm.sh" && nvm use <v> && ...'`. A long-lived server must `exec` its process, or pid-based reaping misses it.

Stop/restart reap the sidecar's whole tmux pane process tree, not just the direct child. Only that tree — anything the command detached from it survives, including docker containers and a compose project. A sidecar that starts detached resources owns tearing them down. `spur sidecar sweep` reports unclaimed process trees (pid, rss, age, worktree), each with its descendant tree's pid list and, when reaped, any survivor pids left after the confirmation window; a trailing line totals the would-free RSS across every reported tree. Nothing dies without `--reap`.

`sidecar sweep` rows carry a `kind`: `worktree-tree` (the original unclaimed-process-tree sweep, reapable when Spur provenance is proven) or `orphan-daemon` (a reparented Spur daemon whose own `cli.js` no longer exists on disk — printed `[report-only]` with its `--config` path, `port`, and `liveness`; never signaled by `--reap`, no matter what). A `serving` row still keeps loading and answering from memory — it prints `[report-only, SERVING on <port>]` and a `daemon stop` pointer instead of the verify-before-killing note. A `liveness: "unknown"` row (the row's own port listener probe itself could not run — neither `lsof` nor `ss` produced a usable result — or its instance config didn't resolve) prints `[report-only, liveness unknown — verify manually before killing]` and never shares the plain not-serving row's "genuinely dead" fix text. A probe that DID run and found zero listeners on the port is `not-serving`, not `unknown` — the probe answered, it just found nobody there.

`sidecar stop` prints the real outcome, never a claimed stop that did not happen, per `sidecarStop.outcome` — causes and the ambiguous-port exclusion rule are in [daemon-api.md#session-routes](daemon-api.md#session-routes): `reaped` (exit `0`), `partial` — names the survivor pids and points at `spur sidecar sweep` (exit `1`), `nothing-to-stop` (exit `0`). `partial`'s survivors can include a detached daemon still holding the sidecar's reserved port, not just a surviving pane process — `stop` always probes the recorded port even when the pane is already gone. `partial` with zero named survivors means the recorded port could not be confirmed clear by this stop, never reported as `reaped` — the message names the port instead of "0 process(es) survived".

### Built-in MCP sidecars

`playwright`, off by default: `sidecars: { playwright: { autoStart: true } }`. Rejects every other key, including `dependsOn`.

### Suppressing a host MCP server

`projects.<id>.mcp.exclude: [name, ...]` drops named MCP servers from claude/codex sessions.
