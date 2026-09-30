# Configuration

> Scope: config layers, fields, sources, triggers, events — names and defaults only. Schema/validation, merge order, and every behavioral rule not stated here: `v2/src/config.ts`. Any config or interface change updates this file in the same change.

Instance config: `~/.spur/config.yaml` by default (daemon host/port, data dirs, tmux socket, default agent, UI port, `voice:` — see [voice.md](voice.md)). Project config: nearest `spur.yaml`/`spur.yml`, `projects:` only. Merge order and per-session resolution: `v2/src/config.ts`.

Spur ToDo is always on, no config field. See [todo](commands.md#todo).

## Config registry

Registered project config paths persist in `config-registry.json` under `dataDir`; a config inside `worktreeDir` is never registered. `spur doctor`'s `config-registry` check flags dead/worktree-internal entries. Mechanics: `v2/src/registry.ts`.

## Local project config

`spur doctor --scaffold` writes a minimal `spur.yaml`. Copyable baseline: [spur.yaml.example](../v2/spur.yaml.example).

## Minimal example

```yaml
server:
  port: 4310
dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
defaultAgent: claude
projects:
  backend-api:
    path: ~/backend-api
    defaultBranch: main
    sessionPrefix: api
```

Full field-by-field shape: [spur.yaml.reference](../v2/spur.yaml.reference).

## selfDestruct, steps

`selfDestruct.enabled: true` on a spawn injects a `spur-self-destruct` instruction after task completion; `conditions` default: every prompt objective done. `steps` sends "step N/total" plus the prompt. Pipeline events: `session.pipeline.step_sent`, `.completed`, `.errored`, `.stalled`.

## Desk groups

`spawnDeskGroup: true` (trigger-level) fans one trigger into multiple sessions sharing one workspace: slots, artifacts, non-MCP sidecars shared; transcript, agent process, MCP sidecar per member. Same sharing applies to the two sides of a handoff. Detail: `v2/src/session-desk.ts`.

## Modes

A mode is a prompt suffix naming a skill, set via `projects.<id>.modes.<name>.{skill,default}`, resolved at spawn from `--mode` / request / trigger `spawn.mode` / project `default: true`. Carried forward by respawn/handoff/restore.

## Telegram binding

`/watch [sessionId]` binds a chat/topic to a session, access via source `allowedUsers`/`allowedChats`. `/spawn [agent] [task]`, `autoSpawn.*` on an unbound message. Attention pushes and reply contract: `v2/src/event-sources/telegram.ts`.

## Event log retention

`events.jsonl`, `user-actions.jsonl` under `dataDir`, sharded per session. `eventLog`/`userActionLog` cap+rotate via `hotBytes`/`shardHotBytes`/`retainArchives`; `eventLog.collapseWindowMs` (default `60000`) collapses repeated warn/error. Instance config only.

## Field reference

Type/constraint/default per key; full validation source `v2/src/config.ts`.

- `server.host` (`127.0.0.1`), `server.port` (`4310`, non-default config path refuses to bind it — [`daemon`](commands.md#daemon)).
- `dataDir` (`~/.spur`), `worktreeDir` (`~/.spur/worktrees`), `projectsRoot` (`<dataDir>/projects`).
- `defaultAgent` (`claude|codex|cursor|opencode`, default `claude`).
- `ui.port` (`5555`; `spur-web.service` `PORT` env wins on mismatch, `spur doctor` warns `web-ui-port-drift`).
- `models.codexHome` (`~/.codex`, instance only).
- `SPUR_CLAUDE_BIN`/`SPUR_CODEX_BIN`/`SPUR_CURSOR_BIN`/`SPUR_OPENCODE_BIN`: process env, per-agent executable override.
- `tags.<name>.{description,color}`: `description` required, instance only.
- `authRotation.{autoRotateOnRateLimit false, cooldownMinutes 60, maxRotationsPerEpisode 2}`: instance only.
- `diskRetention.warnFreeGb` (`10`, instance only, drives `doctor`'s `home-disk-headroom`).
- `rateLimitReactivation.afterHours` (`0`, instance only).
- `staleAfterMinutes` (`720`, instance/per-project). See [Stale mode](#stale-mode).
- `autoUpdate` (`false`, instance only). See [Auto update](#auto-update).
- `sessionGc.{enabled false, olderThanDays 30, intervalMinutes 360, maxGroupsPerSweep 20, statuses [completed,killed,stopped]}`: [`spur gc`](commands.md#gc).
- `artifactRetention.{enabled false, olderThanDays 30, intervalMinutes 360, maxAnchorsPerSweep 20, maxBytesPerSession 2147483648, maxFilesPerSession 500}`: [Artifact retention](#artifact-retention).
- `sidecarGc.{enabled true, idleTtlMinutes 120, maxAgeWarnMinutes 360}`: [Sidecar reaping](#sidecar-reaping).
- `diskBudget.{enabled false, intervalMinutes 360, warnAttributableGb 60, npmCacheMaxGb 20, buildCacheOlderThanDays 14, maxWorktreesPerSweep 20}`: [Disk budget](#disk-budget).
- `tmux.socketName` (`spur-<server.port>`, instance only).
- `eventLog.{hotBytes 134217728, shardHotBytes 16777216, retainArchives 5, collapseWindowMs 60000}`, `userActionLog.{hotBytes 134217728, shardHotBytes 16777216, retainArchives 5}`: [Event log retention](#event-log-retention).
- `admission.{enabled true, maxLiveSessions 100, perSessionBytes 1610612736, reserveFraction 0.7}`: [Admission control](#admission-control).
- `admission.memoryGuard.{enforce false, enforceFloors true, shedEnabled true, minAvailableBytes 1073741824, minFreeSwapBytes 0, admissionFloorBytes, shedCriticalFloorBytes, pressureSomeAvg10Refuse 20, shedSwapUsedFraction 0.9}`: [Admission control](#admission-control).
- `projects.<id>.path` (required), `.defaultBranch` (`main`), `.sessionPrefix` (sanitized id), `.worktree` (`true`), `.defaultAgent`, `.maxLiveSessions`, `.staleAfterMinutes`.
- `projects.<id>.restoreAfterReboot` (`false`). See [Restore after reboot](#restore-after-reboot).
- `projects.<id>.sidecars.<name>` (map, mutually exclusive with `devServer`; built-in `playwright` — [Built-in MCP sidecars](commands.md#built-in-mcp-sidecars)), `.idleTtlMinutes` ([Sidecar reaping](#sidecar-reaping)), `.ports.<id>.{env,start,end,url}` ([Sidecars](commands.md#sidecars)).
- `projects.<id>.mcp.exclude` (`[]`). See [Suppressing a host MCP server](commands.md#suppressing-a-host-mcp-server).
- `projects.<id>.symlinks` (`[]`), `.branchNaming.regex`, `.spawn.steps`, `.preflight`/`.preflight.prompt` (branch or sentinel `NO_PROJECT_RULES`), `.defaultModels`, `.reasoningEffort.{claude,codex}` (`low|medium|high`), `.codexArgs`.
- `projects.<id>.modes.<name>.{skill,default}`. See [Modes](#modes).
- `projects.<id>.sources.<sourceId>.type` (required, `cron|github|github-ci|gitlab|jira|sentry|service|telegram`), `.runOnStart` (`false`), `.schedule` (`cron`), `.intervalMs` (`60000` github/jira, `2000` service), `.query` (github/jira), `.draft` (`false`, github, poll drafts only), `.emitExisting` (`false`), `.maxResults` (`100`, jira, clamped), `.adaptivePoll.{slowIntervalMs,activeGraceMs 600000}`, `.maxReviewBatchTargets`, `.service`, `.tailLines` (`200`), `.rules.<ruleId>.{match,clear,cooldownMs 60000}`, `.token`, `.baseUrl`, `.email` (jira, `${VAR}`-resolvable), `.allowedUsers`, `.allowedChats`, `.autoSpawn.{enabled true,project spur-shepherd,agent opencode,model,selfDestruct}`. Full per-type shape: `v2/src/config.ts`, event names: [Events](#events).
- `projects.<id>.triggers.<triggerId>.{source,event,spawn|send}`.
- `spawn[].{prompt,steps,agent,mode,selfDestruct,branch,overrides.worktree,overrides.defaultBranch,restrictWrites,autoComplete}`, `spawnDeskGroup`. See [Desk groups](#desk-groups), [selfDestruct](#selfdestruct-steps).
- `send.{interrupt false, prompt}`. `false` opens a send window (default 30s, `SPUR_IDLE_WAIT_BEFORE_FLUSH_MS`).
- `projects.<id>.backlog.<backlogId>.{source,query,intervalMs 60000,runOnStart false}` (`.spawn` parsed, ignored — wire a `jira:work_item.new` trigger instead).
- `GET /projects/:id/spawn-defaults?agent=<name>`: `{model, worktree}`. [daemon-api.md](daemon-api.md).

## Admission control

Cap limits concurrent live sessions at spawn, restore, and stale-parked wake. Over cap: `429` naming stop candidates. Reporting route: [`GET /headroom`](daemon-api.md). CLI: [`spur doctor`](commands.md#doctor). Schema `v2/src/config.ts`, enforcement `v2/src/session-service.ts`.

Events: `daemon.memory.shed`(`.failed`), `session.admission.denied`, `session.admission.memory_guard`, `daemon.memory.unbounded`, `daemon.memory.hold.engaged`(`.cleared`/`.failed`), `trigger.send.suppressed_memory_guard`.

## Artifact retention

Prunes `agent-history-*.jsonl` per [desk group](#desk-groups) workspace (never worktrees/records — that's [`spur gc`](commands.md#gc)). Only agent-written, non-user files evictable. Order: `v2/src/artifact-retention.ts`.

## Sidecar reaping

`sidecarGc` kills idle/unowned non-MCP project sidecars (never a built-in MCP one). Shared per [desk group](#desk-groups). Reap/keep rule order: `v2/src/sidecars/policy.ts`, `v2/src/sidecars/reap.ts`. Events: `session.sidecar.reaped`, `session.sidecar.age_warning`.

## Disk budget

`diskBudget` gates a daemon warn sweep over Spur disk usage from `<dataDir>/disk-budget.json`, written only by [`spur disk`](commands.md#disk) — cron it for fresh data. `spur disk`/`spur disk-gc` are daemon-free, work regardless of `enabled`. Emits `host.disk.budget_exceeded` at most once per `intervalMinutes` while over `warnAttributableGb`.

## Stale mode

`staleAfterMinutes` (default `720`) parks an idle session: `status: "stopped"`, `stopReason: "stale_timeout"`, state `stale`; `0` disables. Wake: any system message, through the [admission gate](#admission-control). Mechanics: `v2/src/session-service.ts`.

## Automatic reminders

Claude server-error continuation: 3 attempts, 30+ minutes apart. ToDo nudges: 3 attempts for unchanged open work/blockers/empty ledger — see [todo](commands.md#todo). Pending automatic GitHub/Jira sends: 8 attempts per unchanged item; CI-failure reminders: 3.

## Events

Sources emit events; triggers `spawn` or `send`. Auto-ping scopes: [commands.md#auto-ping](commands.md#auto-ping). `--thread` targets: `github` (review threads), `gitlab` (discussions), `telegram` (forum topics) — no other source has a thread target. `cron`, `github-ci`, `sentry`, `jira` carry no auto-ping controls at all (spawn-only sources). Retry/backoff and poll-cost mechanics: `v2/src/event-sources/*.ts`.

Event names by source:

- `cron`: `cron:tick`.
- `github`: `github:changes_requested`, `ci_failed`, `comment`, `merge_conflict`, `review_requested`, `ready_for_review`, `approved`, `merged`, `closed`, `work_item.new` (with `query`). PR URLs seed the native `session.pr` binding; other review URLs go to `slots.links`. `work_item.new` spawn-prompt template: `{{url}} {{number}} {{title}} {{repo}} {{externalId}}`.
- `github-ci`: `github-ci:run.completed`.
- `gitlab`: `gitlab:changes_requested`, `ci_failed`, `comment`, `merge_conflict`.
- `jira`: `jira:work_item.new` (with `query`; else connection-only, backs `projects.<id>.backlog`). Template: `{{key}}` plus inherited `{{url}} {{number}} {{title}} {{repo}} {{externalId}}`.
- `sentry`: `sentry:issue.new`.
- `service`: `service:<ruleId>`.
- `telegram`: `telegram:message`. Voice-note transcription: [voice.md](voice.md#telegram-voice-notes).

Other event names (see source file for trigger conditions): `trigger.spawn.suppressed`, `source.poll.disabled`, `gh.poll_cycle`, `gh.usage`, `gh.poll_budget_paused`, `session.message.{sent,delivery_recovered,delivery_failed,queue_removed,stalled}`, `session.controls.delivery_recovered`, `session.todo.{nudge_failed,nudge_disabled,nudge_exhausted}`, `session.{complete,pause,self_destruct,desk_complete,handoff}.{completed,failed}`, `session.wake.{failed,daily_failed,interval_failed,sent,daily_sent,interval_sent,interval_cancelled,daily_cancelled,suppressed}`, `session.attention_monitor.{failed,session_failed,slow}`, `session.runtime.{probe_unresponsive,pane_child_fallback}`, `session.agent_process.{pane_pid_unreadable,capture_unavailable,capture_blind,survivors}`, `session.{handoff,respawn}.startup_attachment_missing`, `session.server_error.reactivation_exhausted`, `session.sidecar.{start_noop,start_rejected}`, `session.submit.timeout`, `session.subscription.{delivery_failed,spawn_failed}`, `session.recover.context_unconfirmed`, `trigger.send.{failed,suppressed_admission}`, `host.disk.low`, `daemon.admission.startup`, `daemon.registry.{count,warning}`, `daemon.auto_update.{started,failed,retry,skipped,suppressed,paused,config_invalid,disarm_failed}`, `daemon.deploy_switch.{started,rejected}`, `cli.update.{started,rolled_back,abandoned}`.

## Auto update

`autoUpdate` (instance only, default `false`): self-updates once npm publishes a newer version. Toggle: web `Auto` checkbox or `~/.spur/config.yaml`. Disarm/retry rule, `failureKind` values, ledger (`<dataDir>/update-ledger.jsonl`): `v2/src/auto-update.ts`.

## Restore after reboot

`projects.<id>.restoreAfterReboot` (default `false`) restores reboot-killed sessions and `autoStart` sidecars on boot (reboot-interrupted only). Passes the [admission gate](#admission-control): `session.reboot.restore.failed`/`.aborted`.
