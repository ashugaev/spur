# Commands

> Scope: CLI usage index, names and syntax only. Full behavior: `v2/src/cli.ts`, the command's own source file, or `spur <cmd> --help`. Config fields: [configuration.md](configuration.md). Daemon routes: [daemon-api.md](daemon-api.md).

Hidden from `--help`: `daemon start|stop|restart`, `slots`, `sidecar start|stop|ports|sweep`, `self-destruct`, `branch`, `reinit`, `update-monitor`. Global `--config <path>` (or `SPUR_CONFIG`) selects the instance config.

## Session tools and environment

`$SPUR_SESSION_TOOL_DIR` on `PATH`: `spur`, `spur-slots`, `spur-sidecar`, `spur-self-destruct`, `spur-todo` (+ `spur-branch`, `spur-agent-state`, `spur-isolated` when applicable). Identity env: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SESSION_TOOL_DIR`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_REAL_HOME`. Commands: `$SPUR_SLOT_COMMAND`, `$SPUR_TODO_COMMAND` (+ `$SPUR_AGENT_STATE_COMMAND`, `$SPUR_AGENT_STATE_FILE` for hook-state agents). `$SPUR_CLOSEOUT_OWNER=1` marks the closeout owner; `0` skips git/PR closeout in the Stop hook.

## doctor

Read-only host/config/daemon health check. `--scaffold` writes a minimal local `spur.yaml`. Checks: `sidecar-orphans`, `config-registry`, `session-headroom`, `home-disk-headroom`, `reclaimable-caches`, `claude-onboarding`, `opencode-executable`, `skills-symlinks`, `agent-process-ownership`.

## gc

`spur gc [--execute --no-sizes --limit <n>]` reclaims stale worktrees, archives terminal session records. Defaults: `sessionGc.*` ([configuration.md#field-reference](configuration.md#field-reference)).

## disk

`spur disk [--json]` reports disk usage, writes `<dataDir>/disk-budget.json` ([disk budget](configuration.md#disk-budget)).

## disk-gc

`spur disk-gc [--execute --browser-revisions --older-than <days> --limit <n> --json]` reclaims stale playwright profiles and terminal-worktree build caches.

## artifacts-gc

`spur artifacts-gc [--execute --older-than <days> --max-bytes <bytes> --max-files <n> --project <id> --limit <n> --json]` prunes `agent-history-*.jsonl`. See [Artifact retention](configuration.md#artifact-retention).

## cache

`spur cache [--prune --yes]` reports/prunes host caches outside `~/.spur`.

## daemon

`daemon start|stop|restart` refuse a non-default `--config` claiming the production slot (`server.port` `4310` or `dataDir` `~/.spur`). Auto-start forks a detached daemon unless `$SPUR_SESSION`/`$SPUR_SIDECAR_NAME` is set or `$SPUR_DISABLE_AUTOSTART=1`. Registry: [config registry](configuration.md#config-registry).

## spawn

```bash
spur spawn <project> [prompt...] [--agent claude|codex|cursor|opencode] [--model <id>] [--mode <name>] [--plan] [--restrict-writes] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared] [--subscribe-to <sessionId> ...]
```

Empty `[prompt...]` runs default `spawn.steps`. Modes: [configuration.md#modes](configuration.md#modes).

## shepherd, wake

`spur shepherd [prompt...]` opens Spur's manager session. `spur wake <sessionId> [--in <duration> | --at <iso> | --every <duration> --until <cond> | --daily-at HH:MM[,HH:MM...] --until <cond> | --cancel] [message...]`. Events: [configuration.md#events](configuration.md#events).

## list

`spur list [--json]` reads `GET /sessions` ([daemon-api.md#session-routes](daemon-api.md#session-routes)). TTY: live selector (`Enter` attach, `l` log, `p` pause, `c` complete, `r` restore, `k` kill).

`spur restore <sessionId> [--force] [--json]`, `spur reopen <sessionId> [--force] [--json]` (in place, prompt not resent), `spur respawn <sessionId>` (fresh id, no carryover).

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

One scope flag required: `--event` (occurrence, 30d unredeemed / 24h post-work), `--thread` (provider thread), `--subscription` (route). `SPUR_SESSION` supplies the target inside a session; else pass `--session`. Error `grant_not_ready` means retry.

Routes: [daemon-api.md#session-routes](daemon-api.md#session-routes). Source support: [configuration.md#events](configuration.md#events). Full rules: `v2/src/auto-ping.ts`.

## send, queue

`spur send <sessionId> <message>`. `spur queue <sessionId> list|remove|flush [index]`. Wire: [daemon-api.md#session-routes](daemon-api.md#session-routes). Events: [configuration.md#events](configuration.md#events).

## connect, disconnect

`spur connect [path]` / `spur disconnect [path]`. Accepted configs: [config registry](configuration.md#config-registry).

## spur-slots

`spur-slots --title-if-absent "<title>"`, `spur-slots --link <label>=<url>` — session `PATH` helper for tmux title/links.

## service, memory, agent-issue, comment-seen, subscribe

`spur service run <id> --port <n> -- <command>` / `logs` / `status <id>` — session-bound tmux sidecar wrapper. `spur memory set|get|list|rm [key] [body] --scope task|project|global` — one `.md` file per key. `spur session-memory <sessionId> list|get|set|resolve [key] [body] [--json]` — [daemon-api.md#session-routes](daemon-api.md#session-routes).

`spur agent-issue log <text...>` / `list [--project <id>] [--session <id>] [--limit <n>] [--json]` — friction operating Spur itself, never a repo code defect.

`spur comment-seen record <id...>` — marks GitHub review-comment ids seen, needs `SPUR_PROJECT`.

`spur subscribe <targetSessionId> --state <state>... [--message <text>] [--session <id>] | --list | --remove <subscriptionId>`. States: `working|waiting|needs_input|rate_limited|stale|stopped|error|killed`.

## Sidecars

Start `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, stop `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`. Ports: `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports [--name <name>] [--json]` — `<sidecar> <portId> <env> <port> alive|dead` per line. Sweep: `spur sidecar sweep [--reap]`. Idle-reap: [Sidecar reaping](configuration.md#sidecar-reaping). Outcomes: [daemon-api.md#session-routes](daemon-api.md#session-routes).

Commands run through `sh -lc` (`dash` on Debian/Ubuntu, no `nvm`); use `bash -lc '. "$SPUR_REAL_HOME/.nvm/nvm.sh" && nvm use <v> && ...'`.

### Built-in MCP sidecars

`playwright`, off by default: `sidecars: { playwright: { autoStart: true } }`. Rejects every other key, including `dependsOn`.

### Suppressing a host MCP server

`projects.<id>.mcp.exclude: [name, ...]` drops named MCP servers from claude/codex sessions.
