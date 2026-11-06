# Commands

> Scope: CLI usage index, names and syntax only. Full behavior: `v2/src/cli.ts`, the command's own source file, or `spur <cmd> --help`. Config fields: [configuration.md](configuration.md). Daemon routes: [daemon-api.md](daemon-api.md). CI scheduling: [ci-admission.md](ci-admission.md).

Hidden from `--help`: `daemon start|stop|restart`, `slots`, `sidecar start|stop|ports|sweep`, `self-destruct`, `branch`, `reinit`, `update-monitor`. Global `--config <path>` (or `SPUR_CONFIG`) selects the instance; fallback: [configuration.md](configuration.md).
`review-app prepare|block|recover|status|publish`: daemon-free lane lifecycle, App access and pinned reviews; `recover --legacy-sha256 <digest>` requires exact legacy bytes, returns verified PENDING; row evidence required, legacy coverage optional; `v2/src/review-app.ts`.
`review-gate evaluate`: approval aggregation with `GITHUB_TOKEN` and `--policy`; `v2/src/review-gate.ts`.
`mcp [--http]`, `mcp-tunnel`: daemon MCP, durable backend restart receipts, bounded daemon logs, cache-only attached PR status; `v2/src/mcp.ts`, `v2/src/mcp-tunnel.ts`; [contracts/setup](mcp.md).

## Session tools and environment

`$SPUR_SESSION_TOOL_DIR` on `PATH`: `spur`, `spur-slots`, `spur-sidecar`, `spur-self-destruct`, `spur-todo` (+ `spur-branch`, `spur-agent-state`, `spur-isolated` when applicable); `spur`/`spur-sidecar` wrappers (and tools exec'ing `spur`) wait up to 90s while an update holds the install lock, then run, no wait if lock file or `flock` absent (`v2/src/session-slots.ts`). Identity env: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SESSION_TOOL_DIR`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_SESSION_WORK_DIR`, `$SPUR_REAL_HOME`. `$SPUR_SESSION_WORK_DIR`: `.spur-work` in artifacts dir, agent working files, never listed; `v2/src/session-artifacts.ts`. Unset on daemons before this variable; use `$SPUR_SESSION_ARTIFACTS_DIR/.spur-work` there. Commands: `$SPUR_SLOT_COMMAND`, `$SPUR_TODO_COMMAND` (+ `$SPUR_AGENT_STATE_COMMAND`, `$SPUR_AGENT_STATE_FILE` for hook-state agents). `$SPUR_CLOSEOUT_OWNER=1` marks the closeout owner; `0` skips git/PR closeout in the Stop hook. Launcher exports `$SPUR_ISOLATED_CONFIG`, `$SPUR_ISOLATED_UI_ENDPOINT_FILE`; private runtime-file fields `SPUR_ISOLATED_DAEMON_PID`, `SPUR_ISOLATED_DAEMON_STARTTIME` consumed by UI: current-generation readiness/receipt contract, UI wait budget 30s, `/info` timeout 1s, timeout exits nonzero; `v2/src/isolated-web-endpoint.ts`, `scripts/spur-isolated-ui.sh`.
`$SPUR_AGENT_LAUNCH_ID`: opaque, fresh per agent process generation; agent config cannot override; never persist/reuse; additional live-pane orphan cleanup requires readable exact `$SPUR_SESSION` and attempted-launch markers; missing/mismatched/unreadable markers skipped, baseline matched descendants unchanged — `v2/src/agent-processes.ts`, `v2/src/session-service.ts`. Agent panes also get `DISABLE_AUTO_UPDATE=true` (suppresses the oh-my-zsh update prompt); agent `env` config overrides it.

## doctor

Read-only host/config/daemon health check; `--scaffold` writes local `spur.yaml`; `spur-*-persistence` requires persistent enablement of installed required services; `v2/src/host-install.ts`.

## gc

`spur gc [--execute] [--older-than <days>] [--statuses <list>] [--project <id>] [--limit <n>] [--no-sizes] [--json]` reclaims stale worktrees, archives terminal session records. `--limit` caps groups that act and listed blocked groups; execution probes at most 2x `--limit` groups. Group actions: `reclaim`, `archive`, `partial`, `blocked`. `--older-than` is the minimum age of a record; worktree removal needs every group member eligible; otherwise `partial` archives only eligible records (`archiveSessionIds` in `--json`) and keeps ineligible records, desk anchors they reference, and one record per existing worktree. A dirty, unpushed or open-PR worktree degrades `reclaim` to `partial` with a keeper record. Defaults: `sessionGc.*` ([configuration.md#field-reference](configuration.md#field-reference)).

## disk

`spur disk [--json]` reports disk usage, writes `<dataDir>/disk-budget.json` ([disk budget](configuration.md#disk-budget)).

## disk-gc

`spur disk-gc [--execute --browser-revisions --older-than <days> --limit <n> --json]` reclaims stale playwright profiles and terminal-worktree build caches.

## artifacts-gc

`spur artifacts-gc [--execute --older-than <days> --max-bytes <bytes> --max-files <n> --project <id> --limit <n> --json]` prunes `agent-history-*.jsonl`. See [Artifact retention](configuration.md#artifact-retention).

## opencode-gc

`spur opencode-gc [--execute --older-than <days> --statuses <completed,killed,stopped> --limit <n> --no-sizes --json]` reclaims opencode's own store (root from `opencode db path`). Dry run unless `--execute`, daemon-free. Flags override `opencodeGc.*` ([configuration.md](configuration.md#field-reference)); `--no-sizes` skips `du`. Exits `1` on any error.

- Units: store rows (`opencode session delete`, then one CLI-only `VACUUM`), snapshot leaves whose `[core] worktree` no longer exists, `log/opencode.log` above `opencodeGc.logMaxBytes` (tail kept as `opencode.log.1`, then truncated).
- Selects a store session when a Spur record's `agentSessionId` equals its id and every such record's status is in `opencodeGc.statuses` (default `completed,killed`; `--statuses` overrides).
- Skip reasons: `protected_live_record`, `directory_gone_protected`, `live_process_holds_session`, `directory_unresolvable`, `no_record_match`, `too_recent`, `over_limit`; entry blocked on recheck: `changed_during_run`.
- Plan refusals: `store_unresolved`, `enumeration_failed`, `enumeration_truncated`.
- `VACUUM` skipped with reason: `dry_run`, `no_sessions_deleted`, `db_path_unresolved`, `free_space_unknown`, `insufficient_free_space` (needs 2x DB size free), `live_opencode_record`.
- Bytes: freed files and `VACUUM` DB delta, never summed; dry run reports files only. Mechanism: `v2/src/opencode-gc.ts`.

## cache

`spur cache [--prune --yes]` reports/prunes host caches outside `~/.spur`.

## daemon

`daemon start|stop|restart`: `v2/src/cli.ts`; default instances with a systemd unit refuse detached auto-start/restart: `v2/src/client.ts`; registry: [config registry](configuration.md#config-registry). CLI daemon requests are deadline-bounded per method and an unresponsive `/info` fails without auto-start; a timed-out mutation may still be applied (values in `v2/src/client.ts`).

## init

`spur init [--no-start] [--expose-web] [--web-port <port>] [--no-tailscale]` installs and starts the `spur-daemon`/`spur-web`/`spur-mcp` systemd user units plus configured `spur-mcp-tunnel`. `--expose-web` binds the web UI to `0.0.0.0` instead of `127.0.0.1` (default port `5555`, `--web-port` overrides). `--no-tailscale` skips the Tailscale private-access setup. `init`, `update`, and `reinit` install Cursor's Spur token collector; malformed or unwritable hook config skips metering without blocking setup; the collector runs only in Spur sessions; Claude, Codex, and OpenCode use native structured usage.

## update

`spur update [version] [--force]`: install/monitor/rollback in `v2/src/update.ts`; waits up to 5s for the install lock (rollback too), then fails `another Spur update is already running`; install/reinit failures clear the active attempt and retain `lastFailure` in `~/.spur/rollback-state.json`; daemon version/PID readiness in `v2/src/update-health.ts` (shared with `reinit`).

## spawn

`spur spawn <project> [prompt...] [--agent claude|codex|cursor|opencode] [--model <id>] [--reasoning-effort <level>] [--mode <name>] [--plan] [--restrict-writes] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared] [--subscribe-to <sessionId> --subscribe-state <state> ... [--subscribe-message <text>]] [--json]`

Empty `[prompt...]` skips default `spawn.steps`. Preflight usage counts toward `projects.<id>.tokenBudget`. `--subscribe-state`/`--subscribe-message` require `--subscribe-to`. Modes: [configuration.md#modes](configuration.md#modes).

## shepherd, wake

`spur shepherd [prompt...]` opens Spur's manager session. `spur wake <sessionId> [--in <duration> | --at <iso> | --every <duration> --until <cond> | --daily-at HH:MM[,HH:MM...] --until <cond> | --cancel] [message...]`. Events: [configuration.md#events](configuration.md#events).

## list

`spur list [--json]` reads `GET /sessions` ([daemon-api.md#session-routes](daemon-api.md#session-routes)). TTY: live selector (`Enter` attach, `l` log, `p` pause, `c` complete, `r` restore, `k` kill).
`spur pause <sessionId> [--json]` — keeps the worktree.
`spur complete <sessionId> [--pr-action leave_open|close] [--skip-pr-check] [--json]`.
`spur kill <sessionId> [--force] [--pr-action leave_open|close] [--skip-pr-check] [--json]` — `--force` skips the dirty-worktree/unpushed-commit confirmation.
`spur restore <sessionId> [--force] [--json]`, `spur reopen <sessionId> [--force] [--json]` (in place, prompt not resent) — `--force` bypasses the foreign-live-process refusal; token-budget refusal: [configuration](configuration.md#field-reference). A restore/reopen that clears both gates also clears the session's durable GitHub poll-disable ([configuration.md#automatic-reminders](configuration.md#automatic-reminders)); one refused by either gate leaves it untouched.
`spur respawn <sessionId> [--reasoning-effort <level>] [--force] [--json]` — fresh id; same-agent reasoning override inherited; `v2/src/cli.ts`.
`spur handoff <sessionId> --agent <name> [--model <id>] [--reasoning-effort <level>] [--notes <text>] [--json]` — same workspace; provider/model effort validation in `v2/src/session-service.ts`.

## todo

`spur todo list|add|complete|cancel|hold|resume --session <id> [<itemId>] [--text <text>] [--reason <reason>] [--human-action <action>]`. `$SPUR_TODO_COMMAND`: session-bound, no `--session`. Routes: [daemon-api.md#session-routes](daemon-api.md#session-routes).

## auto-ping

`spur auto-ping mute <handle> [--for <dur>] [--forever] [--reason <why>] [--session <id>] [--json]`: one handle per ping, printed in the ping footer. Default holds until the subject changes (github/gitlab pings only); `--for` max 24h and `--forever` (whole trigger route, this session) need `--reason` — `v2/src/auto-ping.ts`.
`spur auto-ping list [--session <id>] [--all] [--json]`: active mutes; `--all` adds the session's mute history. `SPUR_SESSION` selects the session inside agents — `v2/src/auto-ping.ts`.
`spur auto-ping resume <handle|id> [--session <id>] [--json]`: `SPUR_SESSION` supplies session inside agents — `v2/src/auto-ping.ts`.

## send, queue

`spur send <sessionId> <message>` refuses exhausted token budgets; acknowledged non-slash Cursor input prepends `[Spur delivery: <UUIDv4>]` plus two newlines, queue text unchanged; `v2/src/agents/cursor-submit-ack.ts`. `spur queue <sessionId> list|remove|flush [index]`. Wire: [daemon-api.md#session-routes](daemon-api.md#session-routes). Events: [configuration.md#events](configuration.md#events).

## connect, disconnect

`spur connect [path]` / `spur disconnect [path]`. Accepted configs: [config registry](configuration.md#config-registry).

## source

`spur source poll-enable --session <id>` re-enables GitHub signal polling after a not-found PR permanently disabled a session (see [source.poll.disabled](configuration.md#events)). `--session` defaults to `SPUR_SESSION`. `--json` prints raw JSON. Clears the disable in every `github`-type source of the session's project, and in registry entries of removed or renamed sources; `cleared: []` when nothing was disabled. Route: [daemon-api.md#session-routes](daemon-api.md#session-routes).
`spur source info [--session <id>] [--json]`: read published canonical topic/cached bot identity without allocation; null when absent/disabled/terminal; session defaults to `SPUR_SESSION` — `v2/src/cli.ts`, `v2/src/session-service.ts`.

## source reply

`spur source reply <message...> [--button <label[=value]>]... [--image <path>]... [--session <id>] [--json]`: canonical-topic send; up to 8 buttons; `--image`: up to 4 PNG/JPEG/WebP, 10 MB total, each width+height at most 10000 and side ratio at most 20, posted as photos into the same thread before the text; text failing after photos exits non-zero naming the photo count, no resend; `--request-interface-approval <manifest-file>` requests designated-human semantic consent, daemon appends rendered manifest to message and owns buttons (`--button` rejected); unavailable without forum `chatId<0` — `v2/src/session-service.ts`. Wire: [daemon-api.md#session-routes](daemon-api.md#session-routes); routing: [configuration.md#telegram-binding](configuration.md#telegram-binding).
Telegram `/new <task>`: displayed project defaults, optional engine/mode Settings, runtime-only recent project; requester-owned cards expire after 10 min — `v2/src/event-sources/telegram.ts`, `v2/src/event-sources/telegram-workbench.ts`.
Telegram `/work`: daemon-wide Attention/Working/Recent; inspection leaves routing unchanged, Continue assigns topic, eligible Restore keeps session id and core recovery/budget rules — `v2/src/event-sources/telegram.ts`, `v2/src/server.ts`.
Telegram `/complete`, `/kill`: finish bound forum-topic session, delete owned topics, report in General; no arguments; preserve PR; kill requires saved and pushed work — `v2/src/event-sources/telegram.ts`, `v2/src/session-service.ts`.

## spur-slots

`spur-slots --title-if-absent "<title>"`, `spur-slots --link <label>=<url>`/`--unlink <label>`, `spur-slots --clear-title`, `spur-slots --tag <name>`/`--untag <name>`/`--list-tags` — session `PATH` helper for tmux title/links/tags.
`spur actions [--session <id> | --global] [--limit <n>] [--json]` — logged mutating requests, one session or fleet-wide.

## service, memory, agent-issue, comment-seen, subscribe

`spur service run <id> --port <n> -- <command>` / `status <id>` — session-bound tmux sidecar wrapper. `<id>` must match a `sources.<name>` entry with `type: service` and `service: <id>` ([configuration.md](configuration.md#field-reference)), else `Unknown service`. One-shot commands (tests, lint, type-check) run directly, no service. `spur service logs [sessionId] [name] [--sidecar] [--limit <n>] [--json]` — retained pane and archived rows, default runtime scope and global 200-row limit; route 404/502 errors exit nonzero; `v2/src/cli.ts`. `spur memory set|get|list|rm [key] [body] --scope task|project|global [--session <id>] [--file <path>] [--json]` — one `.md` file per key. `spur session-memory <sessionId> list|get|set|resolve [key] [body] [--json]` — [daemon-api.md#session-routes](daemon-api.md#session-routes).
`spur agent-issue log <text...>` / `list [--project <id>] [--session <id>] [--limit <n>] [--json]` — friction operating Spur itself, never a repo code defect.
`spur comment-seen record <id...>` — marks GitHub review-comment ids seen, needs `SPUR_PROJECT`.
`spur subscribe <targetSessionId> --state <state>... [--message <text>] [--session <id>] | --list | --remove <subscriptionId>`. States: `working|waiting|needs_input|rate_limited|stale|stopped|error|killed`.

## Sidecars

`spur-isolated daemon restart|stop [--json]`: owned-instance control (`UNCONFIRMED`: inspect owner/readiness without replay); [constraints](configuration.md#field-reference); `v2/src/isolated-daemon-owner.ts`.
`SPUR_PROJECT_CONFIG_PATH`: defaults to session project's owning connected config or empty (explicit `sidecars.<name>.env` wins; `v2/src/session-service.ts`, `scripts/spur-isolated-daemon.sh`). Start `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name> [--clear-port <port>]`, stop `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`. Incomplete launch with live tmux: start/restore fails; stop sidecar, retry; confirmed absent tmux permits start (`v2/src/session-service.ts`). Ports: `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports [--name <name>] [--json]` — `<sidecar> <portId> <env> <port> alive|dead listening|not-listening|unknown` per line; `alive` is pane state, `listening` is host TCP socket presence, not HTTP readiness (`v2/src/cli.ts`). Sweep: `spur sidecar sweep [--reap]`. Idle-reap: [Sidecar reaping](configuration.md#sidecar-reaping). Outcomes: [daemon-api.md#session-routes](daemon-api.md#session-routes).
Open: configured reserved TCP listener + live recorded launcher; `v2/src/session-service.ts`. Dev stand: start `isolated-ui` (daemon dependency); `isolated-daemon` alone is backend-only. Seed dedicated TEST JSON once through stdin: `node v2/bin/write-isolated-project-config.mjs --input spur.yaml --output <private-project.yaml> --worktree <checkout> --project <id> --telegram-env-stdin`; unknown project rejects seed; `scripts/spur-isolated-daemon.sh` reuses it, source-free outcomes: `Telegram NOT_CONNECTED/missing-fixture`, `Telegram NOT_CONNECTED/unknown-project`, `Telegram NOT_CONNECTED/owner-busy`.
Native Telegram: [prototype workflow](telegram-calls.md); offline input gate `scripts/telegram-call/bridge.py --check-inputs`; `SPUR_ISOLATED_WITHOUT_TELEGRAM=1` bypasses TEST attachment, default `0`; `scripts/spur-isolated-daemon.sh`.
Commands run through `sh -lc` (`dash` on Debian/Ubuntu, no `nvm`); use `bash -lc '. "$SPUR_REAL_HOME/.nvm/nvm.sh" && nvm use <v> && ...'`. A long-lived server must `exec` its process, or pid-based reaping misses it.
Slot links: omit exact normalized matches of sidecar name and configured reserved URL, including manual duplicates; retain other targets; `v2/src/session-service.ts`.
Stop/restart reap the sidecar's whole tmux pane process tree, not just the direct child. Only that tree — anything the command detached from it survives, including docker containers and a compose project. A sidecar that starts detached resources owns tearing them down. `spur sidecar sweep` reports unclaimed process trees (pid, rss, age, worktree), each with its descendant tree's pid list and, when reaped, any survivor pids left after the confirmation window; a trailing line totals the would-free RSS across every reported tree. Nothing dies without `--reap`.

`sidecar sweep` rows carry a `kind`: `worktree-tree` (the original unclaimed-process-tree sweep, reapable when Spur provenance is proven) or `orphan-daemon` (a reparented Spur daemon whose own `cli.js` no longer exists on disk — printed `[report-only]` with its `--config` path, `port`, and `liveness`; never signaled by `--reap`, no matter what). A `serving` row still keeps loading and answering from memory — it prints `[report-only, SERVING on <port>]` and a `daemon stop` pointer instead of the verify-before-killing note. A `liveness: "unknown"` row (the row's own port listener probe itself could not run — neither `lsof` nor `ss` produced a usable result — or its instance config didn't resolve) prints `[report-only, liveness unknown — verify manually before killing]` and never shares the plain not-serving row's "genuinely dead" fix text. A probe that DID run and found zero listeners on the port is `not-serving`, not `unknown` — the probe answered, it just found nobody there.
`sidecar stop` prints the real outcome, never a claimed stop that did not happen, per `sidecarStop.outcome` — causes and the ambiguous-port exclusion rule are in [daemon-api.md#session-routes](daemon-api.md#session-routes): `reaped` (exit `0`), `partial` — names the survivor pids and points at `spur sidecar sweep` (exit `1`), `nothing-to-stop` (exit `0`). `partial`'s survivors can include a detached daemon still holding the sidecar's reserved port, not just a surviving pane process — `stop` always probes the recorded port even when the pane is already gone. `partial` with zero named survivors means the recorded port could not be confirmed clear by this stop, never reported as `reaped` — the message names the port instead of "0 process(es) survived".

### Built-in MCP sidecars

`playwright`, off by default: `sidecars: { playwright: { autoStart: true } }`. Rejects every other key, including `dependsOn`.

### Suppressing a host MCP server

`projects.<id>.mcp.exclude: [name, ...]` drops named MCP servers from claude/codex sessions.
