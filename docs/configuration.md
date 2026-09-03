# Configuration

Canonical config reference. Any config or interface change updates this file in the same change.

Two layers:

- Instance config: `~/.spur/config.yaml` by default. Daemon host/port, data dirs, tmux socket, default agent, UI port, `voice:` (see [voice.md](voice.md)).
- Project config: nearest `spur.yaml` / `spur.yml`. `projects:` only.

`spur list` and `spur spawn` init the instance config when missing and connect the nearest project config — except one inside `worktreeDir`, never registered (see [Config registry](#config-registry)).

Merge order: instance config, then connected project configs in registry order. First config claiming a project id or `sessionPrefix` wins; a colliding later config is skipped whole for that scan, reconsidered after the earlier owner changes, disconnects, or moves later in order.

A running session reads the `spur.yaml` in its own session directory only — worktree root, or `path` when `worktree: false`. Never a parent's. Without one it uses the project as the daemon has it.

Spur ToDo is always on. It has no config, spawn, source, or trigger field. Command and completion behavior: [todo](commands.md#todo).

## Config registry

Registered project config paths persist in `config-registry.json` under `dataDir`. Boot reloads every registered path, rehydrates sessions, resumes pipelines, restarts sources and triggers.

A config inside `worktreeDir` is never registered. Auto-connect skips it; `POST /projects/connect` and `POST /projects/disconnect` reject a non-absolute `configPath` with 400, and `connect` also rejects one inside `worktreeDir`. The same filter runs in memory at boot and on every connect/disconnect, so a legacy worktree-internal entry stops being merged and drops off on the next registry write.

The registry scan drops dead entries (path gone, or now a directory) and collapses duplicate aliases. Kept instead of dropped: a stat failure that cannot confirm the file is gone (permission error, unmounted path), a missing path whose parent directory still exists, and a lookup or parse error — retried next scan. The instance config is never removed. One `daemon.registry.warning` per problem path per daemon lifetime.

Completing or killing a session unregisters its worktree config path. No-op unless that entry outlived the filter under a `worktreeDir` the host has since moved away from.

`spur doctor` check `config-registry` flags dead entries, worktree-internal entries, and more than 24 registered paths. Severity `warn`, never affects the exit code. Runs only once the systemd units are installed; reads the instance config from `SPUR_CONFIG` or the default path, ignoring `--config`. `--json` adds `configRegistryPaths`: every registered path with its `alive`/`dead`/`worktree-internal` state.

Boot logs one `daemon.registry.count`: paths read, paths dropped by the worktree filter. Read-only.

## Local project config

`spur doctor --scaffold` writes the minimal shape:

```yaml
projects:
  my-project:
    path: .
    defaultBranch: main
    sessionPrefix: my-project
```

Use [spur.yaml.example](../v2/spur.yaml.example) as the copyable baseline. Add `symlinks`, `sources`, `triggers`, `sidecars`, or agent overrides only when the repo needs them.

## Project bootstrap session

Dashboard "+ New project" spawns an ordinary agent session against the unconfigured project. It writes a `spur.yaml`, connects it via `POST /projects/connect`, then asks a short batch of defaulted questions. Ignoring the questions is safe — the connected config stands and the agent never asks again.

Steps, question wording, and the connect call live in `v2/src/bootstrap-prompt.ts`. It points the agent at [spur.yaml.reference](../v2/spur.yaml.reference), a parse-checked sample of many `spur.yaml` keys.

## Full example

```yaml
server:
  port: 4310

dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
projectsRoot: ~/projects
defaultAgent: claude
tmux:
  socketName: spur-4310
ui:
  port: 5555
eventLog:
  hotBytes: 134217728 # 128MB
  shardHotBytes: 16777216 # 16MB
  retainArchives: 5
  collapseWindowMs: 60000
userActionLog:
  hotBytes: 134217728 # 128MB
  shardHotBytes: 16777216 # 16MB
  retainArchives: 5
models:
  codexHome: ~/.codex

projects:
  backend-api:
    path: ~/backend-api
    defaultBranch: main
    sessionPrefix: api
    worktree: true
    defaultAgent: codex # agent chosen when a spawn omits --agent
    defaultModels: # per-agent default model, applied when that agent is chosen without an explicit model
      codex: codex-model-id
      cursor: cursor-model-id
    reasoningEffort:
      claude: medium
      codex: medium
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
    spawn:
      steps:
        - "research"
        - "test"
    preflight: {} # omit prompt to use Spur's default rule-or-defer prompt
    symlinks:
      - .env
      - .claude
    sources:
      weekday-review:
        type: cron
        schedule: "0 9 * * 1-5"
        runOnStart: false
      pr-watch:
        type: github
        intervalMs: 60000
        runOnStart: false
      pr-review-queue:
        type: github
        intervalMs: 600000
        runOnStart: false
        query: "is:pr is:open repo:acme/backend-api label:needs-review" # one session per matched PR, ever
      web-watch:
        type: service
        service: web
        intervalMs: 2000
        tailLines: 200
        rules:
          crash:
            match: "SERVICE_ERROR"
            clear: "SERVICE_OK"
            cooldownMs: 60000
      agent-chat:
        type: telegram
        token: ${TELEGRAM_BOT_TOKEN}
        allowedUsers: [123456789]
    triggers:
      weekday-review-spawn:
        source: weekday-review
        event: cron:tick
        spawn:
          - agent: claude
            model: opus
            prompt: "Review correctness and edge cases."
            steps:
              - "research"
              - "continue implementation"
            overrides:
              worktree: true
          - agent: codex
            prompt: "Review tests and implementation risks."
      pr-watch-changes-requested:
        source: pr-watch
        event: github:changes_requested
        send:
          interrupt: false
          prompt: "Run $manager and $github. Address the latest requested review changes on the active PR."
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: true
          prompt: "Run $manager and $github. Check failing CI on the active PR and fix it if fixable, then rerun and push."
      pr-watch-merge-conflict:
        source: pr-watch
        event: github:merge_conflict
        send:
          interrupt: false
      pr-watch-comment:
        source: pr-watch
        event: github:comment
        send:
          interrupt: false
          prompt: "Run $manager and $github. Review the latest PR comments and address them."
      pr-review-queue-spawn:
        source: pr-review-queue
        event: github:work_item.new
        spawn:
          agent: claude
          prompt: "/code-review {{url}}"
          autoComplete: true
```

## selfDestruct, steps

`selfDestruct.enabled: true` on an API or trigger spawn injects an instruction to run the session-local `spur-self-destruct` helper after the task completes. Blank or omitted `conditions` uses `every objective in the task prompt is done`; an explicit string replaces it.

With `steps`, Spur sends "step 1/N: research" plus the prompt. Without, it sends the prompt directly unless `--plan` appends the planning-only instruction. Empty prompt opens the session with no message — unless a mode resolved, and then the mode instruction is the initial message.

`session.pipeline.step_sent` marks a confirmed step submission, with 1-based `details.stepIndex` and `details.totalSteps`. Spawn logs step 1 (it rides the launch message); the delivery loop logs 2..N. An unconfirmed launch send logs `session.submit.timeout` with `details.freshLaunch` and no `step_sent`.

## Desk groups

```yaml
triggers:
  weekday-review-desk:
    source: weekday-review
    event: cron:tick
    spawnDeskGroup: true
    spawn:
      - agent: claude
        prompt: "Review correctness and edge cases."
        overrides:
          worktree: true
          defaultBranch: main
      - agent: codex
        prompt: "Review tests and implementation risks."
        overrides:
          worktree: true
          defaultBranch: main
```

`spawnDeskGroup: true` requires multiple flat spawn entries, rejects `autoComplete`, and attaches all children to one parent desk. Every entry must resolve to matching `overrides.worktree` and `overrides.defaultBranch`. The desk anchor is the first entry that spawns successfully; if an entry fails, the next one becomes the anchor and the remaining entries join it.

A desk group is any set of sessions sharing one workspace: the children of a `spawnDeskGroup` trigger, and the two sides of a handoff.

Shared per desk: slots (title/links/tags/PR), session artifacts, non-MCP project sidecars (`isolated-daemon`, `isolated-ui`) — one instance, addressable by any member. Per member: transcript, agent process, status, MCP sidecar (`playwright`), session tool dir.

Worktree and shared artifacts survive while any member can still return, so a `stopped`, `paused` or `errored` member keeps them. A shared sidecar and its ports are released once no member has a running agent; restoring a member starts it again.

## Modes

```yaml
projects:
  backend-api:
    modes:
      manager: { skill: manager, default: true }
```

A mode is a prompt suffix naming the skill the session loads. Resolved once at spawn from `--mode`, the `POST /sessions` body, or a trigger `spawn.mode`; explicit request beats the project's `default: true` entry, which beats no suffix. Unknown name fails the spawn, listing configured names. No `modes:` means no suffix. The parser never checks that the skill exists. With an empty prompt the mode instruction becomes the whole initial message.

The web spawn modal shows a mode picker for projects that configure `modes:`, preselected to the `default: true` entry (or none), and forwards the picked name.

Respawn, handoff, and restore carry the persisted mode forward. A mode renamed or removed underneath the session degrades to no-mode with a logged warning instead of blocking.

## Telegram binding

Chats and forum topics bind to sessions with `/watch`. Without an id, Spur replies with an inline picker: sessions from all connected projects grouped by project, each labeled with its session title, plus a back button. `/watch <sessionId>` binds directly. A message from an allowed user in a chat with no live bound session auto-spawns an ephemeral session and binds the chat to it, one per chat; see `autoSpawn` below. One bot token serves all projects; access stays controlled by that source's `allowedUsers` / `allowedChats`. `/watch@otherbot` is ignored in group chats. Bound messages, and messages that spawn a session, reach the agent with a contract: the requester sees only replies sent with `spur source reply "<message>"`, terminal output is invisible.

Attention-monitor pushes into a bound chat: `needs_input`, `error`, `rate_limited` once on entry (pane tail on the first two); a `working`→`waiting` transition with no reply since the last inbound message nudges once; `complete`/`kill` always send a farewell and drop the binding — the forum topic closes too, unless the session was spawned with `selfDestruct` enabled. Notice text and forum topic name carry the session title. Every send is best-effort — a failure never blocks the monitor tick or cleanup.

## Event log retention

Two append-only logs under `dataDir`: `events.jsonl` (daemon/session events) and `user-actions.jsonl` (mutating API calls). Each also shards per session under `<dataDir>/sessions/<id>/`. `hotBytes` caps the root file before it rotates into a `.N.gz` archive, `shardHotBytes` caps each shard. Rotation is lossless and archives read through the same path as the live file. `retainArchives` bounds archives per file — the next rotation past that count deletes the oldest, so history past the window is pruned.

A 5-minute sweep gzips a terminal (`killed`/`completed`/`stopped`) session's shard once, the first time it crosses a small floor. One-way: once a shard has a `.1.gz`, the sweep leaves it alone and size-based rotation takes over.

Repeated `warn`/`error` events sharing `level`+`event`+`sessionId` inside `eventLog.collapseWindowMs` are counted, not appended; the next occurrence past the window flushes one summary line first. The summary carries the LATEST occurrence's `message`/`details` plus `details.suppressedCount` / `details.suppressedSince` — the suppressed occurrences' own payloads are gone, so do not rely on collapse during an incident. Pending counts are in memory only: flushed on clean shutdown and by the sweep, lost on a crash. `info` events and the user-action log are never collapsed. `collapseWindowMs: 0` disables collapsing.

`eventLog` and `userActionLog` are instance config only — a project-config block parses and is discarded. `spur doctor`'s `data-dir-log-bytes` warns above 5GB (`warn`, no exit-code effect). The number is `du -sk <dataDir>/sessions` plus the root `events.jsonl` / `user-actions.jsonl` and their archives, so it runs wider than the log files alone.

## Field reference

- `server.host`: optional, default `127.0.0.1`.
- `server.port`: optional, default `4310`. A daemon booted from any config path other than the default `~/.spur/config.yaml` refuses to bind this port — that slot belongs to the default-path daemon only. See [`daemon`](commands.md#daemon).
- `dataDir`: optional, default `~/.spur` — refused equally whether set explicitly or left to inherit this default, so a non-default config almost always needs an explicit override (see `daemon` link above).
- `worktreeDir`: optional, default `~/.spur/worktrees`.
- `projectsRoot`: optional, default `<dataDir>/projects`. Base for projects created without an explicit `path`; the dashboard/API derives `<projectsRoot>/<project-id>` and creates it.
- `defaultAgent`: optional, `claude|codex|cursor|opencode`, default `claude`.
- `ui.port`: optional, default `5555`. Web UI listen port. `spur-web.service` carries the same number as `Environment=PORT` and wins when both are set; `spur doctor` warns on a mismatch (`web-ui-port-drift`). Moving the port means both — `spur init --web-port <n>` for the unit, `ui.port` here. Sources that call the web UI (Telegram voice transcription, see [voice.md](voice.md#telegram-voice-notes)) resolve their target lazily, at the moment they need it, rather than trusting this field directly: a daemon with no `SPUR_SESSION_TOOL_DIR` in its own process env (any normal daemon) posts to `http://127.0.0.1:<ui.port>`; one that does (an isolated daemon, `scripts/spur-isolated-daemon.sh`) instead reads the outer session's own reserved `isolated-ui` sidecar port and skips transcription (no request sent) when that reservation isn't known yet — this field's own value never matters for that case, and the launcher never writes it.
- `models.codexHome`: optional, default `~/.codex`. Instance config only. Codex picker reads visible entries from `models_cache.json` here; each Codex session copies that cache into its isolated home. Missing, malformed, or empty visible cache returns no Codex models.
- Agent executable overrides: `SPUR_CLAUDE_BIN`, `SPUR_CODEX_BIN`, `SPUR_CURSOR_BIN`, and `SPUR_OPENCODE_BIN`. Each optional process environment value replaces that agent's standard PATH command for preflight, model discovery, launch, restore, transcript reads, and process matching. Use an absolute executable path for daemon and sidecar restarts. A missing OpenCode executable makes model discovery and spawn fail with the command and override name; it never returns a false empty catalog.
- `projects.<id>.path`: required repo path.
- `projects.<id>.defaultBranch`: optional, default `main`.
- `projects.<id>.sessionPrefix`: optional, defaults to a sanitized `<id>`.
- `projects.<id>.worktree`: optional, default `true`. `false` runs in the project path instead of an owned worktree. Override per session with `--worktree`/`--shared` or `trigger.spawn.overrides.worktree`.
- `projects.<id>.restoreAfterReboot`: optional, default `false`. When `true`, the daemon restores this project's reboot-killed sessions and their `autoStart` sidecars on boot. See [Restore after reboot](#restore-after-reboot).
- `projects.<id>.maxLiveSessions`: optional positive integer. Per-project cap on top of the global `admission.maxLiveSessions` cap — a spawn or restore that would put this project over its own cap is refused even while the host is under the global cap. Works in both instance and project config.
- `projects.<id>.staleAfterMinutes`: optional non-negative number. Overrides the instance `staleAfterMinutes` for this project only. See [Stale mode](#stale-mode).
- `projects.<id>.sidecars.<name>`: optional sidecar map (mutually exclusive with `devServer`); a built-in name (`playwright`) needs no `command` and rejects any key besides `autoStart` (`dependsOn` included). See [Built-in MCP sidecars](commands.md#built-in-mcp-sidecars).
- `projects.<id>.sidecars.<name>.idleTtlMinutes`: optional positive integer. Overrides `sidecarGc.idleTtlMinutes` for this sidecar. See [Sidecar reaping](#sidecar-reaping).
- `projects.<id>.sidecars.<name>.ports.<id>`: optional map, `<id>` matches `[a-zA-Z0-9_-]+`. One entry reserves one host port.
- `projects.<id>.sidecars.<name>.ports.<id>.env`: required string. Variable name the reserved port is published under inside the sidecar process, never exported into the agent session — read it with the `ports` command, see [Sidecars](commands.md#sidecars). Not validated as a shell identifier and not unique across sidecars — two sidecars can declare the same `env` name.
- `projects.<id>.sidecars.<name>.ports.<id>.start` / `.end`: both required integers, 1-65535, `end >= start`. Spur scans the range for a free host port at sidecar start.
- `projects.<id>.sidecars.<name>.ports.<id>.url`: optional absolute URL, at most one per sidecar. Carries no explicit port, path, query, or fragment, and the sidecar `<name>` must match `[a-z0-9][a-z0-9_-]{0,15}`. `{port}` is substituted with the reserved port to build the dashboard link.
- `projects.<id>.mcp.exclude`: optional array of MCP server names, default `[]`. Host/global servers Spur drops from this project's claude and codex sessions. See [Suppressing a host MCP server](commands.md#suppressing-a-host-mcp-server).
- `projects.<id>.symlinks`: optional array of repo-relative paths, default `[]`.
- `projects.<id>.branchNaming.regex`: optional JavaScript regex. Validates explicit, trigger, and preflight branches; sessions expose `spur-branch create|rename <name>` and block `git push` on a non-matching branch.
- `projects.<id>.spawn.steps`: optional default phase list; overridden by request or trigger `steps`.
- `projects.<id>.preflight`: optional object; enables strict branch preflight before worktree creation. The agent returns one branch name or `NO_PROJECT_RULES` only.
- `projects.<id>.preflight.prompt`: optional; defaults to Spur's built-in branch-or-no-rules prompt.
- `projects.<id>.defaultAgent`: optional per-project `claude|codex|cursor|opencode`; falls back to top-level.
- `projects.<id>.defaultModels`: optional per-agent default model map, applied when that agent is chosen without an explicit model. Full spawn model-resolution order: request model, then this map, then Spur's built-in per-agent default (`claude` and `cursor` only — `codex` and `opencode` have none), then the agent's own default. The web spawn/respawn/handoff modal always sends a concrete model, resolved in order: carried session model (same agent only), first favorite, this map, agent's first catalog entry. So a web-launched `codex` spawn never falls back to codex's own `config.toml` default, and a `cursor` spawn shows and sends the concrete model cursor's auto-select would land on, not the `auto` placeholder (`auto` only when cursor's catalog offers nothing else).
- `GET /projects/:id/spawn-defaults?agent=<name>`: what the picker calls. Returns `{model, worktree}` — what a spawn with no `model` / `overrides.worktree` would resolve to, model already through the per-agent launch-model rewrite. The web layer caps this route and `/models` at 8s; a direct daemon client is unbounded. `cursor models` is capped at 5s and on timeout returns the built-in `auto` fallback catalog with a 200, same as cursor not installed.
- `projects.<id>.reasoningEffort`: optional `claude` and `codex` map with `low|medium|high`. An omitted provider emits no effort flag. The current project value applies to fresh and background launches, native resume, restore, and `send` relaunch. Cursor ignores this field.
- `projects.<id>.codexArgs`: optional raw Codex arguments. Legacy `model_reasoning_effort` values remain valid. A typed `reasoningEffort.codex` value is appended after raw arguments and wins.
- `projects.<id>.modes.<name>.skill`: required, non-empty; the skill a session in this mode loads.
- `projects.<id>.modes.<name>.default`: optional boolean; at most one mode per project may set it `true`.
- `projects.<id>.sources.<sourceId>.type`: required, `cron|github|github-ci|gitlab|jira|sentry|service|telegram`.
- `projects.<id>.sources.<sourceId>.runOnStart`: optional, default `false`.
- `projects.<id>.sources.<sourceId>.schedule`: required for `cron`.
- `projects.<id>.sources.<sourceId>.intervalMs`: optional; default `60000` for `github`, `2000` for `service`.
- `projects.<id>.sources.<sourceId>.query`: optional `github` `gh search prs` query; one session per matched PR, ever. `--draft=false` by default; set `draft: true` to poll drafts only (an `is:draft` qualifier in `query` cannot override the flag). At most one trigger per source may subscribe to `github:work_item.new`.
- `projects.<id>.sources.<sourceId>.emitExisting`: optional boolean, default `false`. Applies to `github` with `query`, `sentry`, `github-ci`. `true` emits a repo's first-poll backlog instead of suppressing it, at most 10 per repo; suppressed items are recorded as seen either way. Parsed but inert for `gitlab`.
- `projects.<id>.sources.<sourceId>.adaptivePoll`: optional for `github`. Enables slow-window polling; omitted entirely by default, which keeps the existing poll-every-tick cadence.
- `projects.<id>.sources.<sourceId>.adaptivePoll.slowIntervalMs`: optional, default `5 × intervalMs`. Must be greater than `intervalMs`.
- `projects.<id>.sources.<sourceId>.adaptivePoll.activeGraceMs`: optional, default `600000`.
- `projects.<id>.sources.<sourceId>.service`: required for `service`; logical id used by `spur service run <serviceId>`.
- `projects.<id>.sources.<sourceId>.tailLines`: optional for `service`, default `200`.
- `projects.<id>.sources.<sourceId>.rules.<ruleId>.match`: required regex for `service`.
- `projects.<id>.sources.<sourceId>.rules.<ruleId>.clear`: optional regex that clears the active problem state.
- `projects.<id>.sources.<sourceId>.rules.<ruleId>.cooldownMs`: optional for `service`, default `60000`.
- `projects.<id>.sources.<sourceId>.token`: required for `telegram`; supports `${ENV_VAR}` from the project `.env` or process env.
- `projects.<id>.sources.<sourceId>.allowedUsers`: required non-empty Telegram user id allowlist.
- `projects.<id>.sources.<sourceId>.allowedChats`: optional Telegram chat id allowlist; when omitted, any `allowedUsers` member can reach the bot from any shared chat.
- `projects.<id>.sources.<sourceId>.autoSpawn.enabled`: optional boolean, default `true`. `false` replies `No Spur session bound here. Use /watch or /spawn.` in an unbound chat.
- `projects.<id>.sources.<sourceId>.autoSpawn.project`: optional, default `spur-shepherd`.
- `projects.<id>.sources.<sourceId>.autoSpawn.agent`: optional `claude|codex|cursor|opencode`, default `opencode`.
- `projects.<id>.sources.<sourceId>.autoSpawn.model`: optional, no default; requires `agent` to be set. Unset, the spawn falls through the model-resolution order described under `projects.<id>.defaultModels` above. Setting `model` without `agent` throws. Forwarded verbatim — an invalid model surfaces as a `Spawn failed: <cause>` reply.
- `projects.<id>.sources.<sourceId>.autoSpawn.selfDestruct`: optional, default `{enabled: true}`. [selfDestruct](#selfdestruct-steps) shape.
- `projects.<id>.triggers.<triggerId>.source`: required source id.
- `projects.<id>.triggers.<triggerId>.event`: required event name.
- `projects.<id>.triggers.<triggerId>.spawn` | `send`: exactly one required; `spawn` accepts object form or a flat block array.
- `spawn.prompt` / `spawn[].prompt`: required task prompt.
- `spawn.steps` / `spawn[].steps`: optional ordered phase list.
- `spawn.agent` / `spawn[].agent`: optional `claude|codex|cursor|opencode`.
- `spawn.mode` / `spawn[].mode`: optional mode name from `projects.<id>.modes`.
- `spawn.selfDestruct` / `spawn[].selfDestruct`: optional capability config with required `enabled` and optional `conditions`.
- `spawn.branch` / `spawn[].branch`: optional explicit branch; bypasses preflight. Only valid when normalized spawn has one block.
- `spawn.overrides.worktree` / `spawn[].overrides.worktree`: optional boolean.
- `spawn.overrides.defaultBranch` / `spawn[].overrides.defaultBranch`: optional base-branch override, valid only with `worktree: true`.
- `spawn.restrictWrites`: optional boolean, default `false`; when `true`, every spawned block runs restricted to read-only tools unless the block sets its own `restrictWrites`.
- `spawn[].restrictWrites`: optional boolean per block; overrides the spawn-level default for that block only — `true` restricts the block regardless of the spawn-level value, `false` opts the block out of a spawn-level `true`, and omitting it inherits the spawn-level default.
- `spawn.autoComplete`: when `true`, Spur completes the spawned session only after it has existed 5+ minutes and is `waiting`; `working`, `needs_input`, paused, and spawning block completion.
- `spawnDeskGroup`: optional boolean; requires multiple flat spawn entries, rejects `autoComplete`, attaches children to one parent desk, and rejects mixed resolved `overrides.worktree`/`overrides.defaultBranch`.
- `send.interrupt`: optional boolean, default `false`. The first event opens a send window (default 30s, `SPUR_IDLE_WAIT_BEFORE_FLUSH_MS`); merged events keep it. `false` queues while `working`/`needs_input`, dedupes, delivers once the window expired and the session is idle `waiting`. `true` interrupts immediately while `working` only; `waiting` delivers normally, `needs_input` stays queued until `waiting`. `cursor` never gets the `Ctrl-C` keystroke — the message is typed into the running turn and cursor-agent queues it; `claude` and `codex` are interrupted first. Signals gone from the source snapshot before the window expires are pruned at flush; an emptied batch is dropped as `snapshot_pruned`.
- `send.prompt`: optional custom GitHub send action text; replaces built-in action lines when present.
- `projects.<id>.backlog.<backlogId>.source`: required source id; must be a `jira` source.
- `projects.<id>.backlog.<backlogId>.query`: required JQL. Items are served at `GET /backlog/available` in fetch order — the server never re-sorts, so include `ORDER BY Rank ASC` for Jira's real backlog rank.
- `projects.<id>.backlog.<backlogId>.intervalMs`: optional, default `60000`.
- `projects.<id>.backlog.<backlogId>.runOnStart`: optional, default `false`.
- `tags.<name>.description`: required. Sole agent-facing instruction for the tag; conditions (e.g. request-only) live here, not in source. Instance config only — a project-config `tags` block parses without error and is discarded.
- `tags.<name>.color`: optional CSS color; auto-derived from the tag name (hashed hue) when omitted.
- `authRotation.autoRotateOnRateLimit`: optional boolean, default `false`. Instance config only.
- `authRotation.cooldownMinutes`: optional, default `60`.
- `authRotation.maxRotationsPerEpisode`: optional, default `2`.
- `diskRetention.warnFreeGb`: optional, default `10`. Instance config only. Drives `doctor`'s `home-disk-headroom` check and the pre-spawn `host.disk.low` warning; see [commands.md](commands.md#cache) for the `spur cache` command it points at.
- `rateLimitReactivation.afterHours`: optional, default `0`. Instance config only.
- `staleAfterMinutes`: optional non-negative number, default `720` (12 hours). Instance config only. Minutes a `running` session may sit idle (state `waiting`) before parking. `0` disables parking. See [Stale mode](#stale-mode).
- `autoUpdate`: optional boolean, default `false`. Instance config only. See [Auto update](#auto-update).
- `sessionGc.enabled`: optional boolean, default `false`. Instance config only. `true` lets the daemon run the [`spur gc`](commands.md#gc) policy on a timer; `spur gc` itself works regardless.
- `sessionGc.olderThanDays`: optional, default `30`. Minimum age of a group's newest record. Also the `spur gc --older-than` default.
- `sessionGc.intervalMinutes`: optional, default `360`. Minimum gap between daemon sweeps; the timer ticks every 5 minutes and skips until the gap has passed, so a daemon restart never sweeps immediately.
- `sessionGc.maxGroupsPerSweep`: optional positive integer, default `20`. Per-sweep group cap (the CLI's own default cap is `100`).
- `sessionGc.statuses`: optional non-empty array, default `[completed, killed, stopped]`. Only these three values are accepted; anything else fails config parse.
- `sidecarGc.enabled`: optional boolean, default `true`. Instance config only. On by default, unlike `sessionGc`: this reaper kills a restartable sidecar process, never a worktree or a record. See [Sidecar reaping](#sidecar-reaping).
- `sidecarGc.idleTtlMinutes`: optional positive integer, default `120`. Workspace idle time that reaps a non-MCP project sidecar. Per-sidecar override: `projects.<id>.sidecars.<name>.idleTtlMinutes`. See [Sidecar reaping](#sidecar-reaping).
- `sidecarGc.maxAgeWarnMinutes`: optional positive integer, default `360`. Process age at which a kept sidecar logs `session.sidecar.age_warning`. Warn only — it authorizes no kill.
- `tmux.socketName`: optional, default `spur-<server.port>`. Instance config only.
- `eventLog.hotBytes`: optional, default `134217728` (128MB). Instance config only. See [Event log retention](#event-log-retention).
- `eventLog.shardHotBytes`: optional, default `16777216` (16MB).
- `eventLog.retainArchives`: optional, default `5`.
- `eventLog.collapseWindowMs`: optional, default `60000` (60s); `0` disables collapsing, negative rejected.
- `userActionLog.hotBytes`: optional, default `134217728` (128MB). Instance config only.
- `userActionLog.shardHotBytes`: optional, default `16777216` (16MB).
- `userActionLog.retainArchives`: optional, default `5`.
- `admission.enabled`: optional boolean, default `true`. `false` disables cap refusal, floor refusal, and critical shedding; legacy `minAvailableBytes` / `minFreeSwapBytes` warnings may still log. Instance config only — project config ignores `admission` before semantic parsing.
- `admission.maxLiveSessions`: optional positive integer, default `100`. Global cap on concurrently live (`running`/`spawning`, plus a session mid-restore) sessions. Agent state does not affect the count: a `waiting` or `needs_input` session remains `running` and keeps its slot. An explicit value wins over memory-sizing fields.
- `admission.perSessionBytes`: optional positive number, default `1610612736` (1.5 GiB). Estimated worst-case memory cost of one live session. Setting this field without `maxLiveSessions` opts into the memory-derived cap.
- `admission.reserveFraction`: optional number in `(0, 1]`, default `0.7`. Fraction of total host memory reserved for sessions. Setting this field without `maxLiveSessions` opts into the memory-derived cap.
- `admission.memoryGuard.enforce`: optional boolean, default `false`. Controls only legacy `minAvailableBytes` / `minFreeSwapBytes`: `false` logs `session.admission.memory_guard` and admits; `true` refuses the spawn or restore.
- `admission.memoryGuard.enforceFloors`: optional boolean, default `true`. Refuses spawn below `admissionFloorBytes`, restore below `restoreFloorBytes`, or either operation above the PSI threshold.
- `admission.memoryGuard.shedEnabled`: optional boolean, default `true`. Enables the 1-second critical-memory sampler and staged shedding.
- `admission.memoryGuard.minAvailableBytes`: optional non-negative number, default `1073741824` (1 GiB). Guard threshold on `/proc/meminfo`'s `MemAvailable`; `0` effectively disables the available-memory half of the guard.
- `admission.memoryGuard.minFreeSwapBytes`: optional non-negative number, default `0`. Guard threshold on `/proc/meminfo`'s `SwapFree`; `0` effectively disables the swap half of the guard.
- `admission.memoryGuard.admissionFloorBytes`: optional non-negative number. Default `max(1073741824, floor(MemTotal / 8))`.
- `admission.memoryGuard.shedCriticalFloorBytes`: optional non-negative number. Default `max(536870912, floor(MemTotal / 16))`; must be lower than `admissionFloorBytes`.
- `admission.memoryGuard.pressureSomeAvg10Refuse`: optional percentage from `0` through `100`, default `20`. Refuses admission when cgroup v2 memory PSI `some avg10` exceeds it.
- `admission.memoryGuard.shedSwapUsedFraction`: optional number in `(0, 1]`, default `0.9`. Starts critical shedding when host swap use reaches this fraction.

## Admission control

Cap limits concurrent live sessions at spawn, restore, and waking a stale-parked session. One slot covers the agent and its MCP/service sidecars. At or above either cap the caller gets a `429` naming the cap, claimed slots split into live sessions and in-flight reservations, and up to 3 stop candidates (stalest `updatedAt` first) — that project's sessions on a per-project denial, the fleet on a global one. With no live candidate the message says to wait for an in-flight spawn, then stop a session or retry. Lowering the cap kills, pauses, and reconciles nothing.

`GET /headroom` returns `cap.global`, `cap.source`, `cap.perSessionBytes`, `cap.reserveFraction`, `projectCaps`, `live.count`, `live.byProject`, host-memory/guard values, and live sessions ordered by stale `updatedAt` with `id`, `project`, `status`, `rssBytes`. `projectedRoom` is `max(0, cap.global - live.count)` — it ignores per-project caps, guard state, and in-process reservations. CLI output: [`spur doctor`](commands.md#doctor).

`cap.source`: `default` for untouched sizing, `config` for explicit `maxLiveSessions`, `derived` when a sizing field is explicit without a maximum. Derived cap is `max(1, floor(totalHostMemoryBytes * reserveFraction / perSessionBytes))`, the omitted sizing field keeping its default; restart the daemon to re-derive after a host-memory change. Startup logs `daemon.admission.startup` with `cap`, `capSource`, live count.

`rssBytes` sums process RSS across the session's agent, MCP, service, and sidecar panes; unmeasurable panes report `0`. Reporting only — admission uses slots and guard thresholds.

Memory floors read remaining `MemAvailable`. Restore floor is `admissionFloorBytes + perSessionBytes`, keeping `shedCriticalFloorBytes < admissionFloorBytes < restoreFloorBytes`. Missing `/proc` or cgroup v2 PSI data fails open, as do missing or malformed sampler reads.

The 1-second sampler reads host `MemAvailable` plus daemon-cgroup `memory.current`, `memory.high`, `memory.max`. Host memory wins when auto scopes sit outside the daemon cgroup.

Below the critical floor each tick stops at most one safe sidecar. Session shedding starts after 12s of continuous low host RAM; host RAM at half the critical floor (capped at 2 GiB) or finite cgroup-max headroom at that threshold skips the grace period — one sidecar, re-sample, then at most one session pause. `memory.high` alone authorizes sidecar shedding only. Order: sessions `rate_limited` before `waiting`, oldest `updatedAt` first; sidecars all built-in MCP before project. Untouched: `working`, `needs_input`, restore-warmup, unclassifiable sessions, protected shared sidecars. Paused sessions stay restorable.

Pressure closes at the admission floor (RAM), below the cgroup-high threshold by the smaller of 10% or the emergency threshold, or above twice the emergency headroom (finite max). Swap-only shedding starts disarmed, arms after swap recovers 10 percentage points below `shedSwapUsedFraction`, and spends one sidecar attempt per recovery. Healthy and recovery ticks log nothing. Events: `daemon.memory.shed`, `daemon.memory.shed.failed`, `session.admission.denied`, `session.admission.memory_guard`, startup warning `daemon.memory.unbounded`.

## Sidecar reaping

`sidecarGc` kills idle and unowned project sidecar processes. Candidates: non-MCP sidecars under `projects.<id>.sidecars`; a built-in MCP sidecar (`playwright`) never is. Runs on the sidecar-reaper tick and once at boot.

A reap kills the sidecar's tmux pane process tree, drops its recorded process, and unlinks its published slot link. Session record, worktree, and port reservation survive; a restart is a normal sidecar start ([Sidecars](commands.md#sidecars)).

A non-MCP sidecar is shared by its whole [desk group](#desk-groups) workspace. Every rule below reads the workspace, not one session.

Active workspace: some member is `running`, `spawning`, or in restore warmup. `stopped`, `paused`, `errored`, `completed`, `killed` count as inactive.

Idle time: now minus the newest activity over all members, per member `lastActivityAt` falling back to record `updatedAt`. One active member holds the shared sidecar for the rest.

Decision per sidecar, first match wins:

1. `sidecarGc.enabled: false` — keep.
2. MCP sidecar — keep.
3. No live pane and no recorded process — keep.
4. Established TCP connection on any port reserved for this sidecar — keep. Outranks every reap rule below, on any owner status.
5. Connection probe unreadable on any of those ports — keep.
6. Owner record gone — reap.
7. Worktree gone — reap.
8. Workspace not active — reap, whatever the idle time.
9. No parsable activity timestamp on any member — keep.
10. Idle time at or past the sidecar's `idleTtlMinutes` — reap.
11. Otherwise — keep.

A dev server survives a pass while something holds a connection to one of its reserved ports (rule 4), or while its workspace is active (rule 8) under the TTL (rule 10). The probe reads recorded reservations only: no reservation and no live pane means no rule-4/5 veto; a live pane declaring ports without a recorded reservation keeps under rule 5.

Each pass logs `session.sidecar.reaped` per kill with the matched rule and freed tree RSS, and `session.sidecar.age_warning` per kept sidecar past `maxAgeWarnMinutes` — once per sidecar per window, not per tick.

Every session view (`GET /sessions`, `GET /sessions/<id>`, dashboard) carries each sidecar's `ageSeconds` (omitted when unresolvable) and `ageWarn` (true at `maxAgeWarnMinutes`, the same threshold as the event). The session detail page, the dashboard sidecars row, and `spur list` ([list](commands.md#list)) render the age and mark an over-threshold one.

Cross-workspace port collision: a sidecar start refuses when this workspace's recorded reservation for this sidecar matches a live other workspace's recorded reservation for a non-MCP sidecar in the same project AND that port is free right now. The error names the holding workspace and sidecar; stop that sidecar or its session first — Spur reuses no pane and reaps nothing across a workspace boundary. Refuses nothing: a shared `ports` range alone, an occupied colliding port (the start scans for another free port), a same-workspace sidecar, another project, a holder with no live pane, an explicit `clearPort`.

## Stale mode

`staleAfterMinutes` (instance, default `720`, 12 hours) parks a `running` session idle in state `waiting` that long: pane killed, live sidecars torn down, record written `status: "stopped"`, `stopReason: "stale_timeout"`, `staleSidecars` (names tmux-alive at park time), derived state `stale`. `0` — instance or `projects.<id>.staleAfterMinutes` — disables parking for that scope. Never parked: `working`, `needs_input`, `rate_limited`, queued or in-flight work, Shepherd sessions, and a session with no transcript activity signal at all. The idle clock is the agent's transcript activity, or the parsed reset instant of a claude rate limit that just expired when that is later — still not a routine record write (`agentSessionId` capture, PR field update, slot unlink, `serverError`/`rateLimitedAt` clear), not a tmux attach, so an open web terminal never holds a session unparked.

Waking passes the same [admission gate](#admission-control) as spawn and restore. Refused: a trigger delivery or queued-message drain retries through its own path; a scheduled/interval/daily wake re-arms the same occurrence for the next tick; a manual send or Resume is rejected like an over-cap spawn.

Any system message wakes a parked session silently — GitHub/review event, trigger send, scheduled/interval/daily wake, manual send: pane relaunched, `staleSidecars` replayed, message delivered once the agent process is live, no restore prompt when the native transcript resumes. On a fresh-launch fallback (no native resume, or it failed) the original task prompt is resent first, wrapped as restore does — every fresh-launch fallback, parked or not. The resend waits on the agent's submit ack for claude and cursor, skips it for codex (as `spur restore` does). Ack never confirmed but pane alive: the resend proceeds and logs `session.recover.context_unconfirmed`. Manual Resume (`spur restore`, web Resume) wakes with no message. After a wake the record carries neither `stopReason` nor `staleSidecars`.

`spur list` and the dashboard show a parked session as state `stale`, in the Stopped group, with its Resume action.

## Events

Sources emit events; triggers `spawn` a new session or `send` into an existing one.

- `cron`: `cron:tick`.
- `github`: `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`, `github:ready_for_review`, `github:approved`, `github:merged`, `github:closed`, and `github:work_item.new` when `query` is set.
- `github-ci`: `github-ci:run.completed`.
- `gitlab`: `gitlab:changes_requested`, `gitlab:ci_failed`, `gitlab:comment`, `gitlab:merge_conflict`.
- `jira`: none. Connection only (`baseUrl`, `email`, `token`, all `${VAR}`-resolvable); the source loop skips it — it exists only to back `projects.<id>.backlog`.
- `sentry`: `sentry:issue.new`.
- `service`: `service:<ruleId>` per configured rule.
- `telegram`: `telegram:message` after an allowed user binds a chat with `/watch`. `text` also carries a transcribed voice note, see [voice.md](voice.md#telegram-voice-notes).

`github` polls running sessions, matches each to a PR branch, emits changed signals only; state persists under `dataDir`. With `query` set it also runs `gh search prs <query>` on the same interval, emits `github:work_item.new` per unseen PR, and persists seen `<owner>/<repo>#<n>` ids. GitHub PR URLs seed the native `session.pr` binding; other review URLs stay in `slots.links` with `label: "pr"`. Spawn prompts reference work-item fields with `{{url}}`, `{{number}}`, `{{title}}`, `{{repo}}`, `{{externalId}}`.

`github:ci_failed`: retry every 10 minutes, stop after 3 deliveries, reset when the failing signal leaves the snapshot. `github:merge_conflict`: one-shot on becoming conflicting, cleared when mergeable, re-emittable. Terminal events (`merged`/`closed`) fire only while the owning session runs; after one, polling pauses while that session stays bound to the same PR — sticky across daemon restarts — and resumes on rebinding to a different PR. That first poll re-baselines, absorbing signals already true on the new PR. A session with no PR binding is always polled.

A session bound to a PR number GitHub reports as nonexistent stops signal polling for that PR number after one attempt, logs `source.poll.disabled` once, and re-enables on rebinding to a different PR number or on daemon restart — in-memory only, not sticky like the terminal-signal pause above. Any other poll failure retries on a doubling backoff (2 minutes to a 30-minute cap) instead of every cycle.

With `adaptivePoll`, a tick makes zero `gh` calls unless: the slow deadline (`slowIntervalMs` since the last real poll) passed, the last cycle saw a non-terminal CI check, a tracked session is unpolled, or a session had a `send`/source-reply within `activeGraceMs`. A session gated by the permanent not-found stop or by transient poll backoff never counts as "unpolled" and never re-arms the tick. Rate-limit cooldown backoff overrides all of it, here and on plain sources. With `query` also set, discovery runs on the same gated tick; every gate reads already-tracked sessions, so an undiscovered PR cannot re-arm the tick early.

GitHub poll-cost events: `gh.poll_cycle` (one completed poll cycle; `calls`, `graphqlCost`; consecutive zero-call cycles collapse into the first event of the run, the swallowed count lands on the next emitted event as `suppressedZeroCycles`), `gh.usage` (minute/hour `gh` invocation and GraphQL-cost windows), `gh.poll_budget_paused` (polling skipped to preserve the shared GraphQL reserve; includes remaining budget and reset time when known), `source.poll.disabled` (signal polling stopped for one session because its bound PR number was not found; carries `prNumber`).

Message delivery events: `session.message.sent`, `session.message.delivery_recovered` (submit ack timed out, process alive), `session.message.delivery_failed` (retried next poll, repeats suppressed after the first), `session.message.queue_removed`.

Wake events: a synchronous send failure logs `session.wake.failed`/`daily_failed`/`interval_failed`; a queued pane-write failure logs `session.wake.sent`/`daily_sent`/`interval_sent` instead. A recurring wake dropped on `killed` logs `session.wake.interval_cancelled`/`daily_cancelled`. An unrecoverable-but-restorable session logs `session.wake.suppressed` once on that transition.

## Daemon restarts

Tmux agent sessions survive daemon restarts: the systemd unit uses `KillMode=process`, so `systemctl restart` stops the node process only. On boot the daemon re-discovers living sessions, resumes delivery loops and pipelines, restarts attention monitoring.

Trigger pending batches persist in `<dataDir>/pending-send-batches.json` and reload at startup, minus records whose trigger no longer matches config or whose payload no longer parses. Lost on restart: retry counters (a reloaded batch restarts at attempt 1), the send window (fresh window at restore), the state-classification cache (rebuilt in seconds), the state-history ring buffer.

Unit files here are templates. Source deployments apply them through [install-from-source.md#deploy](install-from-source.md#deploy); npm user units refresh through [install-from-npm.md#upgrade](install-from-npm.md#upgrade).

## Auto update

`autoUpdate` (instance config only, default `false`) self-updates the daemon: once the npm registry publishes a version strictly newer than the running one, it runs the same switch a `Switch` press runs — same executor, guards, durable status record. See [Daemon HTTP API](daemon-api.md#daemon-http-api).

Toggle from the `Auto` checkbox in the web version popover, or by hand: `autoUpdate: true`/`false` in `~/.spur/config.yaml`, re-read from disk every reaper tick — a hand edit takes effect on the next tick, no restart. Detection lag up to ~15 minutes (5-minute reaper tick plus the 10-minute registry cache), not immediate.

An accepted `POST /deploy/switch` — what `Switch` sends — also sets `autoUpdate: false`. The daemon's own auto-update switch does not: a self-updated host stays armed for the next release.

The daemon writes `autoUpdate: false` itself once one of its own attempts installs a version and leaves the host changed (`failureKind` `rolled_back` or `install_unhealthy`), or dies without reporting what it did (`failureKind` `interrupted_unknown`), and logs `daemon.auto_update.paused`. At most once per version, ever: a hand edit back to `autoUpdate: true` holds. Only the daemon's own attempt disarms this way; [`spur update`](install-from-npm.md#upgrade) never touches the flag.

`<dataDir>/update-ledger.jsonl` is append-only, never pruned or rotated: one `blocked` line per version that installed and left the host changed, one `disarmed` line per disarm. A `blocked` version is never auto-attempted again on that host, even after the status record is gone — suppression logs `reason` `blocked_version`.

The web version popover names that version — `rolled_back`, `install_unhealthy`, or `interrupted_unknown`, any initiator — and says auto-update is suspended only where that is true, i.e. an auto-initiated failure with the flag now off. The notice clears on the next operator action on the update path: re-enable `Auto`, or any accepted `Switch`. A later such failure raises it again, naming the new version. A separate, unrelated notice — `restart_skipped` — shows a succeeded install that could not restart the services (no `systemctl`); it clears on its own once the daemon's running version matches the installed one, no operator action needed. Field: [`updateFailure`](daemon-api.md#daemon-http-api).

Retry rule, keyed on the failed attempt's [`failureKind`](daemon-api.md#daemon-http-api):

- `install_failed` — target never installed, including a lock timeout that gave up before the install started. Retried every tick, no cap, no backoff.
- no `failureKind` — a record written by the daemon's own spawn-error path, or the helper died before it armed its own trap (invalid version, or killed during its pre-trap wait for the daemon's `running` record). Nothing installed. Retried the same way.
- `rolled_back` — installed, failed, previous version reinstalled. Never auto-retried.
- `install_unhealthy` — installed, failed, previous version not restored. Never auto-retried.
- `interrupted_unknown` — the run died without reporting what it did (killed, OOM, reboot); whether it installed is unknown. Never auto-retried, disarms `autoUpdate` once for an auto-initiated attempt same as the two kinds above; re-enabling `Auto` clears the record and unblocks one further attempt.
- `succeeded` — never retried, even when the running version is still the older one; a `restart_skipped` outcome on that record only adds a notice, it never changes this rule.

Only the newest release is ever a candidate: a suppressed or blocked newest release stops the auto path until the registry publishes a newer one, never falls back to an older release.

Update events, every initiator: `daemon.auto_update.started`, `daemon.auto_update.retry`, `daemon.auto_update.suppressed` (with `reason` `succeeded_record`, `no_retry_kind`, or `blocked_version`), `daemon.auto_update.skipped`, `daemon.auto_update.failed`, `daemon.auto_update.paused`, `daemon.auto_update.config_invalid`, `daemon.auto_update.disarm_failed`, `daemon.deploy_switch.started`, `daemon.deploy_switch.rejected`, `cli.update.started`, `cli.update.rolled_back`, `cli.update.abandoned`. All in the [event log](#event-log-retention).

`daemon.auto_update.suppressed` is `info` — it repeats every tick while the suppressed release is the newest one. `paused` and `disarm_failed` are `warn`.

Rollback reaches only failures the switch helper itself detects ([daemon-api.md](daemon-api.md#daemon-http-api)). A failure surfacing minutes after a healthy restart is caught by neither the deploy-switch path nor `spur update`'s monitor; auto-update inherits that gap, does not widen it.

Pin a version by hand while auto-update is on: turn `autoUpdate` off first — [install-from-npm.md#upgrade](install-from-npm.md#upgrade) has the order and the reason.

## Restore after reboot

`projects.<id>.restoreAfterReboot` (default `false`) restores this project's reboot-killed sessions and their `autoStart` sidecars on boot. Reboot-interrupted sessions only (panes gone) — never `pause`/`kill`/`complete`, never `errored` with a surviving pane. Manual sidecars are not tracked. `Ctrl-C`/`SIGTERM` mid-restore shuts down gracefully. Each restore passes the [admission gate](#admission-control): cap refusal leaves that session stopped and logs `session.reboot.restore.failed`; restore-floor refusal stops the batch and logs `session.reboot.restore.aborted`.

## spur init (npm host flags)

`spur init` installs the `spur-daemon`/`spur-web` systemd user units. Flags: `--no-start`; `--expose-web` (public `0.0.0.0` bind, default `127.0.0.1`); `--web-port <port>` (default `5555`); `--tailscale`/`--no-tailscale` (default on — widens `spur-web.service` `WEB_HOST` to `127.0.0.1,<tailnet-ip>` once the tailnet is up; loopback stays bound; never `0.0.0.0`). `--expose-web` is the explicit public override and supersedes Tailscale. `WEB_HOST` takes a comma-separated host list (`packages/web/server/web-hosts.ts`); `spur-web`'s production server binds one listener per host. Full walkthrough: [install-from-npm.md](install-from-npm.md).
