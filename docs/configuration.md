# Configuration

Canonical config reference. Any config or interface change updates this file in the same change.

Two layers:

- Global instance config: `~/.spur/config.yaml` by default. Owns daemon host/port, data dirs, tmux socket, default agent, UI port, and `voice:` (see [voice.md](voice.md)).
- Local project config: nearest `spur.yaml` / `spur.yml`. Owns only `projects:`.

`spur list` and `spur spawn` auto-initialize the global config when missing and auto-connect the nearest local project config when present.

The daemon merges the instance config first, then connected project configs in registry order. The first config claiming a project id or `sessionPrefix` wins. A later config colliding on either value is skipped whole for that scan and reconsidered after the earlier owner changes, disconnects, or moves later in order.

Registry scans canonicalize registered paths and persist the cleaned order. A missing config is removed only when its parent directory is also gone. Live-parent misses stay registered and retry after the parent directory changes; lookup errors stay registered and retry on each scan. The instance config is never removed. A canonical problem path emits at most one `daemon.registry.warning` per daemon lifetime.

A running session reads only the `spur.yaml` in its own session directory — the worktree root, or `path` when `worktree: false`. Never a parent's. Without one the session uses the project as the daemon has it.

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

When `selfDestruct.enabled` is true on an API or trigger spawn, Spur injects an instruction to run the session-local `spur-self-destruct` helper after the task completes. Omitting `conditions` (or leaving it blank) uses the default completion condition, `every objective in the task prompt is done`; an explicit `conditions` string is trimmed and replaces it.

With `steps`, Spur sends "step 1/N: research" plus the original prompt. Without `steps`, it sends the prompt directly unless `--plan` appends the planning-only instruction. Empty prompt opens the session with no message.

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

`spawnDeskGroup: true` requires multiple flat spawn entries, cannot combine with `autoComplete`, and attaches all children to one parent desk/workspace. Every entry must resolve to matching `overrides.worktree` and `overrides.defaultBranch`; mixed workspace overrides are rejected.

A desk group is any set of sessions sharing one workspace: the children of a `spawnDeskGroup` trigger, and the two sides of a handoff.

Members share slots (title/links/tags/PR), session artifacts, and non-MCP project sidecars (`isolated-daemon`, `isolated-ui`) — one shared instance per desk, addressable by any member. Each member still keeps its own transcript, agent process, status, MCP sidecar (`playwright`), and session tool dir.

The worktree and the shared artifacts survive while any member can still return, so a `stopped`, `paused` or `errored` member keeps them. A shared sidecar and its reserved ports are released as soon as no member has a running agent; restoring a member starts it again.

## Telegram binding

Chats and forum topics bind to sessions with `/watch`. Without an id, Spur replies with an inline picker; `/watch <sessionId>` binds directly. Bound messages reach the agent with `Source: telegram` and are answered with `spur source reply "message"` from inside the session — Telegram-spawned sessions get that contract in their prompt. `/watch@otherbot` is ignored in group chats.

Bound chats get proactive pushes from the attention monitor: `needs_input`, `error`, and `rate_limited` each push once on entry (with a pane tail for the first two), and the forum topic name tracks state. A `working`→`waiting` transition with no reply since the last inbound message nudges the chat once. `complete`/`kill` send a farewell and close the topic. Every send is best-effort — a Telegram failure never blocks the monitor tick or cleanup.

## Field reference

- `server.host`: optional, default `127.0.0.1`.
- `server.port`: optional, default `4310`. A daemon booted from any config path other than the default `~/.spur/config.yaml` refuses to bind this port — that slot belongs to the default-path daemon only. See [`daemon`](commands.md#daemon).
- `dataDir`: optional, default `~/.spur` — refused equally whether set explicitly or left to inherit this default, so a non-default config almost always needs an explicit override (see `daemon` link above).
- `worktreeDir`: optional, default `~/.spur/worktrees`.
- `projectsRoot`: optional, default `<dataDir>/projects`. Base for projects created without an explicit `path`; the dashboard/API derives `<projectsRoot>/<project-id>` and creates it.
- `defaultAgent`: optional, `claude|codex|cursor`, default `claude`.
- `ui.port`: optional, default `5555`. Web UI listen port. `spur-web.service` carries the same number as `Environment=PORT` and wins when both are set; `spur doctor` warns on a mismatch (`web-ui-port-drift`). Moving the port means both — `spur init --web-port <n>` for the unit, `ui.port` here.
- `models.codexHome`: optional, default `~/.codex`. Instance config only. Codex picker reads visible entries from `models_cache.json` here; each Codex session copies that cache into its isolated home. Missing, malformed, or empty visible cache returns no Codex models.
- `projects.<id>.path`: required repo path.
- `projects.<id>.defaultBranch`: optional, default `main`.
- `projects.<id>.sessionPrefix`: optional, defaults to a sanitized `<id>`.
- `projects.<id>.worktree`: optional, default `true`. `false` runs in the project path instead of an owned worktree. Override per session with `--worktree`/`--shared` or `trigger.spawn.overrides.worktree`.
- `projects.<id>.restoreAfterReboot`: optional, default `false`. When `true`, the daemon restores this project's reboot-killed sessions and their `autoStart` sidecars on boot. See [Restore after reboot](#restore-after-reboot).
- `projects.<id>.maxLiveSessions`: optional positive integer. Per-project cap on top of the global `admission.maxLiveSessions` cap — a spawn or restore that would put this project over its own cap is refused even while the host is under the global cap. Works in both instance and project config.
- `projects.<id>.sidecars.<name>`: optional sidecar map (mutually exclusive with `devServer`); a built-in name (currently only `playwright`) needs no `command` and rejects any key besides `autoStart` (`dependsOn` included). See [Built-in MCP sidecars](commands.md#built-in-mcp-sidecars).
- `projects.<id>.mcp.exclude`: optional array of MCP server names, default `[]`. Host/global servers Spur drops from this project's claude and codex sessions. See [Suppressing a host MCP server](commands.md#suppressing-a-host-mcp-server).
- `projects.<id>.symlinks`: optional array of repo-relative paths, default `[]`.
- `projects.<id>.branchNaming.regex`: optional JavaScript regex. Validates explicit, trigger, and preflight branches; sessions expose `spur-branch create|rename <name>` and block `git push` on a non-matching branch.
- `projects.<id>.spawn.steps`: optional default phase list; overridden by request or trigger `steps`.
- `projects.<id>.preflight`: optional object; enables branch suggestion before worktree creation.
- `projects.<id>.preflight.prompt`: optional; defaults to Spur's built-in rule-or-defer prompt.
- `projects.<id>.defaultAgent`: optional per-project `claude|codex|cursor`; falls back to top-level.
- `projects.<id>.defaultModels`: optional per-agent default model map, applied when that agent is chosen without an explicit model.
- `projects.<id>.reasoningEffort`: optional `claude` and `codex` map with `low|medium|high`. An omitted provider emits no effort flag. The current project value applies to fresh and background launches, native resume, restore, and `send` relaunch. Cursor ignores this field.
- `projects.<id>.codexArgs`: optional raw Codex arguments. Legacy `model_reasoning_effort` values remain valid. A typed `reasoningEffort.codex` value is appended after raw arguments and wins.
- `projects.<id>.sources.<sourceId>.type`: required, `cron|github|github-ci|gitlab|jira|sentry|service|telegram`.
- `projects.<id>.sources.<sourceId>.runOnStart`: optional, default `false`.
- `projects.<id>.sources.<sourceId>.schedule`: required for `cron`.
- `projects.<id>.sources.<sourceId>.intervalMs`: optional; default `60000` for `github`, `2000` for `service`.
- `projects.<id>.sources.<sourceId>.query`: optional `github` `gh search prs` query; one session per matched PR, ever. `--draft=false` by default; set `draft: true` to poll drafts only (an `is:draft` qualifier in `query` cannot override the flag). At most one trigger per source may subscribe to `github:work_item.new`.
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
- `projects.<id>.triggers.<triggerId>.source`: required source id.
- `projects.<id>.triggers.<triggerId>.event`: required event name.
- `projects.<id>.triggers.<triggerId>.spawn` | `send`: exactly one required; `spawn` accepts object form or a flat block array.
- `spawn.prompt` / `spawn[].prompt`: required task prompt.
- `spawn.steps` / `spawn[].steps`: optional ordered phase list.
- `spawn.agent` / `spawn[].agent`: optional `claude|codex|cursor`.
- `spawn.selfDestruct` / `spawn[].selfDestruct`: optional capability config with required `enabled` and optional `conditions`.
- `spawn.branch` / `spawn[].branch`: optional explicit branch; bypasses preflight. Only valid when normalized spawn has one block.
- `spawn.overrides.worktree` / `spawn[].overrides.worktree`: optional boolean.
- `spawn.overrides.defaultBranch` / `spawn[].overrides.defaultBranch`: optional base-branch override, valid only with `worktree: true`.
- `spawn.autoComplete`: when `true`, Spur completes the spawned session only after it has existed 5+ minutes and is `waiting`; `working`, `needs_input`, paused, and spawning block completion.
- `spawnDeskGroup`: optional boolean; requires multiple flat spawn entries, rejects `autoComplete`, attaches children to one parent desk, and rejects mixed resolved `overrides.worktree`/`overrides.defaultBranch`.
- `send.interrupt`: optional boolean, default `false`. `false` queues while `working`/`needs_input`, dedupes, flushes when `waiting`. `true` interrupts immediately while `working`; `needs_input` still queues.
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
- `rateLimitReactivation.afterHours`: optional, default `0`. Instance config only.
- `sessionGc.enabled`: optional boolean, default `false`. Instance config only. `true` lets the daemon run the [`spur gc`](commands.md#gc) policy on a timer; `spur gc` itself works regardless.
- `sessionGc.olderThanDays`: optional, default `30`. Minimum age of a group's newest record. Also the `spur gc --older-than` default.
- `sessionGc.intervalMinutes`: optional, default `360`. Minimum gap between daemon sweeps; the timer ticks every 5 minutes and skips until the gap has passed, so a daemon restart never sweeps immediately.
- `sessionGc.maxGroupsPerSweep`: optional positive integer, default `20`. Per-sweep group cap (the CLI's own default cap is `100`).
- `sessionGc.statuses`: optional non-empty array, default `[completed, killed, stopped]`. Only these three values are accepted; anything else fails config parse.
- `tmux.socketName`: optional, default `spur-<server.port>`. Instance config only.
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

Cap limits concurrent live sessions at spawn and restore. One slot covers agent and its MCP/service sidecar processes. At or above either cap, caller gets a `429` naming cap, claimed slots split into live sessions and in-flight reservations, and up to 3 stop candidates (stalest `updatedAt` first). Per-project denials list that project's sessions; global denials list fleet. With zero live stop candidates, message says to wait for an in-flight spawn, then stop a live session or retry. Lowering cap leaves existing sessions live; Spur kills, pauses, or reconciles none.

`GET /headroom` returns `cap.global`, `cap.source`, `cap.perSessionBytes`, `cap.reserveFraction`, configured `projectCaps`, `live.count`, `live.byProject`, host-memory/guard values, and live sessions ordered by stale `updatedAt`. Each session entry includes `id`, `project`, `status`, and `rssBytes`. `projectedRoom` equals `max(0, cap.global - live.count)`; it excludes per-project caps, memory-guard state, and in-process admission reservations. See [`spur doctor`](commands.md#doctor) for CLI output.

Cap source reports `default` for untouched sizing, `config` for explicit `maxLiveSessions`, and `derived` when either sizing field is explicit without a maximum. Derived mode uses `max(1, floor(totalHostMemoryBytes * reserveFraction / perSessionBytes))`; the omitted sizing field keeps its default. Restart daemon to re-derive after host-memory changes. Daemon startup logs `daemon.admission.startup` with `cap`, `capSource`, and live count. The 1.5 GiB default leaves room above the 1.21 GiB design estimate for one agent plus MCP sidecars.

`rssBytes` sums process RSS attached to the session's agent, MCP, service, and sidecar tmux panes. Missing pane/process measurements report `0`. RSS is reporting-only; admission uses live-session slots and guard thresholds.

Memory floors use remaining `MemAvailable`. Restore floor is derived as `admissionFloorBytes + perSessionBytes`, preserving `shedCriticalFloorBytes < admissionFloorBytes < restoreFloorBytes`. On the 67,418,697,728-byte reference host, these resolve to 4,213,668,608, 8,427,337,216, and 10,037,949,952 bytes. Missing `/proc` or cgroup v2 PSI data fails open.

The 1-second sampler reads host `MemAvailable` plus daemon-cgroup `memory.current`, `memory.high`, and `memory.max`. Host memory remains authoritative when source-install auto scopes sit outside the daemon cgroup. Missing or malformed samples fail open for that signal.

Below the critical floor, each tick stops at most one safe sidecar. Session shedding starts after 12 seconds of continuous low host RAM. Host RAM at half the critical floor, capped at 2 GiB, or finite cgroup-max headroom at that threshold bypasses the grace period: the tick tries one sidecar, re-samples pressure, then pauses at most one session if pressure still authorizes it. `memory.high` alone permits sidecar shedding, never session shedding. Session order remains `rate_limited` before `waiting`, oldest `updatedAt` first. Sidecar order remains all built-in MCP sidecars before project sidecars. `working`, `needs_input`, restore-warmup, unclassifiable sessions, and protected shared sidecars stay untouched. Paused sessions remain restorable.

RAM pressure closes at the admission floor. Cgroup-high pressure closes below its threshold by the smaller of 10% or the emergency threshold. Finite-max pressure closes above twice the emergency headroom. Swap-only shedding starts disarmed after daemon startup, arms after swap recovers 10 percentage points below `shedSwapUsedFraction`, and spends one sidecar attempt before another recovery. Recovery and healthy ticks emit no memory event. Actions, partial failures, and edge-triggered exhaustion retain `daemon.memory.shed` / `daemon.memory.shed.failed`; other memory events remain `session.admission.denied`, `session.admission.memory_guard`, and startup warning `daemon.memory.unbounded`.

## Events

Sources emit events; triggers `spawn` a new session or `send` into an existing one.

- `cron`: `cron:tick`.
- `github`: `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`, `github:ready_for_review`, `github:approved`, `github:merged`, `github:closed`, and `github:work_item.new` when `query` is set.
- `github-ci`: `github-ci:run.completed`.
- `gitlab`: `gitlab:changes_requested`, `gitlab:ci_failed`, `gitlab:comment`, `gitlab:merge_conflict`.
- `jira`: none. Connection only (`baseUrl`, `email`, `token`, all `${VAR}`-resolvable); the source loop skips it — it exists only to back `projects.<id>.backlog`.
- `sentry`: `sentry:issue.new`.
- `service`: `service:<ruleId>` per configured rule.
- `telegram`: `telegram:message` after an allowed user binds a chat with `/watch`.

`github` polls running sessions, matches each to a PR branch, and emits only changed signals; state persists under `dataDir`. When `query` is set it also runs `gh search prs <query>` on the same interval, emits `github:work_item.new` per unseen PR, and persists seen `<owner>/<repo>#<n>` ids in an append-only registry. GitHub PR URLs seed the native `session.pr` binding; non-GitHub review URLs stay in `slots.links` with `label: "pr"`. Spawn prompts reference work-item fields with `{{url}}`, `{{number}}`, `{{title}}`, `{{repo}}`, `{{externalId}}`.

`github:ci_failed` uses one fixed policy: retry every 10 minutes, stop after 3 deliveries, reset only when the failing signal disappears from the latest snapshot. `github:merge_conflict` is snapshot-based and one-shot: emitted when the PR becomes conflicting, cleared when mergeable again, re-emittable if conflicts return. Terminal events (`merged`/`closed`) fire only while the owning session still runs. Once fired, polling pauses for that session as long as it stays bound to the same PR — sticky across daemon restarts, since the snapshot persists under `dataDir` — and resumes automatically once the session is rebound to a different PR; that first poll re-baselines against the new PR, so signals already true on it (e.g. an existing `changes_requested`) are absorbed silently instead of delivered, and only later changes emit. A session with no PR binding is always polled.

With `adaptivePoll` configured, a `github` source tick is a no-op — zero `gh` calls — unless: the slow deadline (`slowIntervalMs` since the last real poll) has passed; the last cycle saw a non-terminal CI check; a tracked session hasn't been polled yet; or a session had a `send`/source-reply within `activeGraceMs`. The existing rate-limit cooldown backoff still overrides everything above, on `adaptivePoll` sources and plain ones alike. When `query` is also set, `github:work_item.new` discovery (`gh search prs`) runs on the same gated tick as session polling; every gate condition is scoped to already-tracked sessions, so a new, undiscovered PR alone cannot re-arm the tick early — discovery waits for the slow deadline or for an existing session to re-qualify.

## Daemon restarts

Tmux agent sessions survive daemon restarts. The systemd unit uses `KillMode=process`, so `systemctl restart` stops only the node process — tmux and agents keep running. On boot the daemon re-discovers living sessions, resumes delivery loops and pipelines, and restarts attention monitoring.

Trigger pending batches persist under `dataDir` (`pending-send-batches.json`) and reload at startup, minus records whose trigger no longer matches config or whose payload no longer parses. State that does not survive a restart: retry counters (a reloaded batch restarts at attempt 1), the state-classification cache (rebuilt within seconds), and the state-history ring buffer (starts empty).

Unit files in this repository are templates only. Source deployments apply them through [install-from-source.md#deploy](install-from-source.md#deploy); npm user units refresh through [install-from-npm.md#upgrade](install-from-npm.md#upgrade). System-unit operators adapt and reload them in their own maintenance window.

## Restore after reboot

`projects.<id>.restoreAfterReboot` (default `false`) opts a project into automatic restore of sessions and their `autoStart` sidecars that a host reboot killed. On boot the daemon restores only reboot-interrupted sessions (panes gone) — never intentional `pause`/`kill`/`complete`, never `errored` sessions whose pane survived but whose agent died. Only `autoStart` sidecars return; manual ones are not tracked. A mass restore stays interruptible: `Ctrl-C`/`SIGTERM` mid-restore shuts down gracefully. Each restore passes through the [admission gate](#admission-control): cap refusal leaves that session stopped and logs `session.reboot.restore.failed`; restore-floor refusal stops the remaining batch and logs `session.reboot.restore.aborted`.

## spur init (npm host flags)

`spur init` installs the `spur-daemon`/`spur-web` systemd user units. Flags: `--no-start`; `--expose-web` (public `0.0.0.0` bind, default `127.0.0.1`); `--web-port <port>` (default `5555`); `--tailscale`/`--no-tailscale` (default on — widens `spur-web.service` `WEB_HOST` to `127.0.0.1,<tailnet-ip>` once the tailnet is up; loopback stays bound; never `0.0.0.0`). `--expose-web` is the explicit public override and supersedes Tailscale. `WEB_HOST` takes a comma-separated host list (`packages/web/server/web-hosts.ts`); `spur-web`'s production server binds one listener per host. Full walkthrough: [install-from-npm.md](install-from-npm.md).
