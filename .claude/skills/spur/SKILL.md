---
name: spur
description: Use when working on Spur — its CLI, daemon, tmux/worktree session flow, cron sources/triggers, config shape, and validation rules.
---

# Spur

## Fixed facts

- Spur is CLI plus local HTTP daemon. `packages/web` is the only supported UI — a thin Next.js frontend over the daemon HTTP API that must not grow its own backend or runtime logic.
- Treat the Spur interface as fixed unless the user asks to change it.
- Discover the current human-facing command surface from `v2/src/cli.ts` and `spur --help`. Do not hard-code a command list in prompts. `daemon start` stays as the internal daemon command and is hidden from `spur --help`.
- `spur init` (npm install host flags) takes `--no-start`, `--expose-web` (0.0.0.0, public, explicit override), `--web-port <port>`, `--tailscale`/`--no-tailscale` (default on: widens `spur-web.service` `WEB_HOST` to `127.0.0.1,<tailnet-ip>` once Tailscale is up, loopback stays bound either way, never binds `0.0.0.0`). See `docs/configuration.md` and `docs/install-from-npm.md`.
- `spur init` / `spur update` / `spur reinit` re-apply `npm config set prefix ~/.local` when `~/.npmrc` lost the line (never overwrites an operator-set `prefix=` line or an explicit non-`~/.local` pin). Every agent session also runs with `NPM_CONFIG_PREFIX=~/.local` so `claude`/`codex` self-update lands there regardless of `~/.npmrc`'s current state.
- `spawn` is positional: `spur spawn <project> [prompt...]` with optional `--agent claude|codex|cursor`, `--branch <name>`, `--plan`, `--restrict-writes`, repeatable `--step <label>`, and either `--worktree [defaultBranch]` or `--shared`. Empty prompt opens a blank session and skips default pipeline steps and initial message injection.
- Supported agents are only `claude`, `codex`, and `cursor`.
- Supported agents start with full access by default:
  `claude --dangerously-skip-permissions`
  `codex --dangerously-bypass-approvals-and-sandbox`
  `agent --force --sandbox disabled`
- Workspace setup is only:
  `git worktree` + configured symlinks + detached `tmux` + agent launch.
- `list` hides `completed` and `killed` sessions by default.
- Minimal automation is only:
  `sources -> events -> triggers -> spawn|send`
- Current built-in source types are `cron`, `github`, `gitlab`, `sentry`, `service`, and `telegram`.
- Spur supports a lean sequential startup pipeline:
  one task prompt plus optional `steps` phase labels such as `research`, `develop`, and `test`.
- Project config may define default `spawn.steps`. Manual/API/trigger `steps` override that default.
- Later phases are sent only after the agent returns to its prompt.
- `cron` emits `cron:tick`.
- `github` emits `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`,
  `github:ready_for_review`, `github:approved`, `github:merged`, `github:closed`.
  `github:comment` covers top-level PR comments and review comments/replies.
  Lifecycle events (`ready_for_review`, `approved`, `merged`, `closed`) fire on transition.
  First poll per session sets baseline, no emit; pre-existing true state stays silent. Baseline
  persists across daemon restarts. `github:merged` and `github:closed` fire only while owning
  session runs; dropped if stopped (same as other github signals).
- `github` with `query` emits `github:work_item.new` per open PR. First poll per repo records
  backlog, no emit. `emitExisting: true` emits backlog once, capped at 10. Poll excludes drafts by
  default (`--draft=false`); set `draft: true` on the source to poll draft PRs only. An `is:draft`
  qualifier in `query` cannot override this flag.
- `sentry` polls Sentry issues, emits `sentry:issue.new` per new issue. Shares work-item
  spawn/autoComplete lifecycle. First poll suppresses backlog unless `emitExisting: true`, capped at 10.
- `telegram` uses grammY runner long polling. Allowed users, optionally chat-scoped, can bind a chat or forum topic
  to a session with `/watch` picker or `/watch <sessionId>`; bound text emits `telegram:message`.
  Agents reply to the same Telegram target with `spur source reply "message"`.
  Spawned sessions get that source-reply contract in their prompt, and `/watch`/`/spawn` bind failures are surfaced to the chat.
  The attention monitor pushes `needs_input`/`error`/`rate_limited` notices (with a tmux pane tail on
  `needs_input`/`error`) to bound chats, skips the startup baseline, nudges once on a `working` to
  `waiting` transition with no reply since the last inbound message, and sends a farewell plus closes
  the forum topic before unbinding on `complete`/`kill`. Every push is best-effort: failures log and
  never break the monitor tick, the nudge, or session cleanup.
- `runOnStart` defaults to `false`.
- When a self-update reaches the `failed` phase, `VersionSwitchOverlay` in `packages/web` shows a `Diagnose update` button that POSTs `{ target }` to web route `POST /api/diagnose-update`. The route builds a diagnostic prompt server-side and spawns the built-in Shepherd through daemon `POST /shepherd/spawn`, which is project-independent and works on a clean install with no configured projects.

## Current config shape

```yaml
server:
  port: 4310

dataDir: ~/.spur
worktreeDir: ~/.spur-worktrees
projectsRoot: ~/.spur/projects # optional; default <dataDir>/projects; base dir for projects created without an explicit path
defaultAgent: claude

tags:
  bug:
    description: Fixing a defect or regression
  feature:
    description: New user-facing capability
  docs:
    color: "#a371f7"
    description: Documentation only

projects:
  backend-api:
    path: ~/backend-api
    defaultBranch: main
    sessionPrefix: api
    defaultAgent: codex
    defaultModels:
      codex: gpt-5.5
      cursor: auto
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
    spawn:
      steps: [research, test]
    symlinks: [.env, .claude]
    sources:
      weekday-review:
        type: cron
        schedule: "0 9 * * 1-5"
        runOnStart: false
    triggers:
      weekday-review-spawn:
        source: weekday-review
        event: cron:tick
        spawn:
          prompt: "Review all open PRs"
          agent: codex
          model: gpt-5.5
          restrictWrites: true
          allowedTriggers: []
          steps:
            - "research"
            - "develop"
            - "run $code-simplifier"
            - "test"
```

Model selection: project `defaultModels` is a per-agent map keyed by agent name; the entry for the resolved agent applies when that agent is chosen without an explicit model, and never bleeds onto another agent. A trigger spawn block `model` applies to that block's `agent` — trigger `model` requires trigger `agent` or config load fails; unknown `defaultModels` keys also fail load. UI spawn/respawn modals expose a searchable model picker; CLI `spur spawn` takes `--model <id>`, applied to the resolved agent (from `--agent`, else the default agent). No model set means the runtime's own default. Sources: claude = curated aliases (opus/sonnet/haiku/fable), codex = `models_cache.json` under `CODEX_HOME`, cursor = `agent models` output.

### Sentry source

`authToken` resolves from env (`${VAR}`); load fails fast if unresolved. Defaults: `baseUrl`
`https://sentry.io`, `query` `is:unresolved`, `intervalMs` 60000. `emitExisting: true` processes
backlog once. Pair with `autoComplete` spawn trigger for short-lived per-issue agents.

```yaml
sources:
  sentry-issues:
    type: sentry
    authToken: ${SENTRY_TOKEN}
    org: my-org
    project: my-project
    query: "is:unresolved"
    emitExisting: false
triggers:
  sentry-issue-spawn:
    source: sentry-issues
    event: sentry:issue.new
    spawn:
      prompt: "Triage Sentry issue {{title}}: {{url}}"
      autoComplete: true
```

GitHub backlog: add `emitExisting: true` to a `query` source to spawn agents for existing open PRs once.

### Jira backlog

`jira` source = connection only (`baseUrl`/`email`/`token`, env-resolved); emits no events, source loop
skips it. A `backlog.<id>` binding references a source and sets `query` (JQL), optional `intervalMs`
(default 60000), `runOnStart` (default false). `provider` derives from source type. Backlog subsystem
polls each binding and serves items at `/backlog/available` only. Item order is fetch/JQL order (server
never re-sorts); include `ORDER BY Rank ASC` in `query` to surface Jira's real backlog rank order.

Dashboard "Take task" opens the default spawn window prefilled with `Work on {{key}}: {{title}}\n\n{{url}}`
and the item's project preset; no request fires until the user submits. The spawned session carries a
`tracker` link (`{label: "tracker", url: item.url}`). The dashboard hides the backlog row client-side
while any active session (working/waiting/needs_input/rate_limited) references the issue, matched by
tracker link or a bounded key/url token in the session prompt; the row reappears once that session leaves
the active set.

```yaml
sources:
  jira:
    type: jira
    baseUrl: https://org.atlassian.net
    email: ${JIRA_EMAIL}
    token: ${JIRA_API_TOKEN}
backlog:
  features:
    source: jira
    query: "project = WEB AND statusCategory != Done ORDER BY updated DESC"
    intervalMs: 60000
    runOnStart: false
```

### Claude auth rotation

Rotate Claude login accounts across the rate limit. Each account is an isolated
`CLAUDE_CONFIG_DIR` in a runtime store (`<dataDir>/claude-accounts.json` +
`<dataDir>/claude-accounts/<id>/`). Accounts are not declared in config.

Accounts UI: the StatusBar footer "Accounts" menu adds, selects, and removes
accounts. Add opens an interactive login terminal; operator runs `/login` OAuth;
Spur auto-detects the account once `.credentials.json` lands. Select sets the
active account; remove drops it. The default ~/.claude login is auto-adopted as an account named "default" when its .credentials.json exists.

Per-session switch auth (claude sessions only): kills and relaunches the session
under the chosen account's `CLAUDE_CONFIG_DIR`, preserving `--resume`. Force
switches even while the session is working. Each account's `CLAUDE_CONFIG_DIR/projects` symlinks to shared `~/.claude/projects`, so `--resume <uuid>` resolves the same transcript across accounts; history preserved on rotation.

Auto-rotation: config toggle `authRotation.autoRotateOnRateLimit`. Agent-agnostic
rotation policy (the config carries no agent name so it extends to other agents;
the account store is currently claude-only). When on,
a claude session that hits `rate_limited` rotates to the next authenticated,
non-cooldown account. Guards: `cooldownMinutes` (per-account skip window after a
limit), `maxRotationsPerEpisode` (cap per rate-limit episode). All accounts
limited -> falls through to the reactivation nudge.

Instance-only, same footgun as `rateLimitReactivation`/`tags`: this block is
parsed only in instance config. A per-project `spur.yaml authRotation:` is
silently ignored.

```yaml
authRotation:
  autoRotateOnRateLimit: true
  cooldownMinutes: 60
  maxRotationsPerEpisode: 2
```

## Main flow

```text
spawn
  -> ensure daemon
  -> POST /sessions
  -> allocate session id
  -> create worktree
  -> apply symlinks
  -> start tmux
  -> launch agent
  -> send task prompt or first staged phase
  -> auto-send later phases after each prompt return
  -> persist session metadata
```

## Cron flow

```text
cron source
  -> emit cron:tick
  -> matching trigger
  -> normal Spur spawn
```

## Working rules

- Keep Spur lean. One task, one interface, one code path.
- Do not keep alternative command forms.
- Do not add speculative fields or helper layers.
- If code is not part of current Spur behavior, remove it.
- Defaults belong at config parsing boundaries, not inside runtime hot paths.
- Tags: instance-level catalog only (`name`, `description`, optional `color`; color auto-derived from name when omitted; project `spur.yaml` `tags:` is parsed but discarded — no runtime effect). `description` is the sole agent-facing instruction: conditions (e.g. request-only) live there, not in source. Agents tag only on clear description match, via `--tag`/`--untag`/`--list-tags` through `$SPUR_SLOT_COMMAND`. Spawn prompt lists the catalog; dashboard shows colored chips, hidden on mobile.
- Prefer the smallest type shape that preserves safety. Concision beats type-level cleverness.
- Runtime state detection: `codex` sessions use hook state plus rollout JSONL. `claude` sessions use `~/.claude/sessions/*.json` before agent history JSONL fallback. `cursor` sessions use transcript JSONL.
- Do not commit machine-specific hosts, public URLs, or other environment-local values into repo config. Use `${VAR}` placeholders and keep real values in the environment.

## CLI Convention

- Human-first output by default; structured commands expose `--json`.
- Single theme object: brand accent `#f04c4c` (ids, tiny loading frames), brand mark `𖤓` (help headers, runtime summary, spinner). Status dots: green = `active|ready`, yellow = `idle|waiting_input|spawning`, red = `errored`, gray = `killed|exited`.
- Visual primitives: accent, bold, dim, whitespace. No boxes, wide tables, rainbow status, or decorative state aliases.
- `@clack/prompts` only for transient UI (spinner, select, log, note); data rendering stays custom and flat — `list` is the reference renderer.
- Dense stacked cards: primary line = `id`, status dot, state, project, agent, branch; secondary line = `updated`, runtime/worktree facts, at most one short exceptional hint.
- `list` is the only session UI. On TTY: runtime summary + live selector + selected details; `Enter` attaches, `p` pauses, `c` completes, `r` restores a restorable exited session, `k` kills, `Esc` quits. Non-TTY: one-shot runtime summary + session cards.
- Never silently retarget keys after refresh — if the selected id disappears, require explicit reselection.
- Empty states: one sentence + one dim next-step hint.
- Animation: at most a one-line transient spinner during waits, cleared before final output.

## Agent Isolation

- The `spur` CLI in your PATH targets your isolated instance, not production. Use it as-is.
- Port 4310 is the production daemon. Never target it with `spur daemon start`, `kill`, or direct HTTP calls.
- Do not override `--config` to point at `~/.spur/config.yaml` (root config).
- Do not kill processes or ports you did not start. Your session tool dir is in `$SPUR_SESSION_TOOL_DIR`.
- For `packages/web` work and local testing in this repo, use Sidecar only. Start it with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>` and prefer the project `sidecars` config (for example `dev`). Do not rely on `spur-sidecar` being in `PATH`; use the helper from `$SPUR_SESSION_TOOL_DIR`.
- Do not start app, dev server, or test helper processes directly with `pnpm`, `next`, or similar commands unless the user explicitly tells you to bypass Sidecar.
- Isolated daemon configs inherit `voice` from user config; server, data, tmux stay isolated. Add new key branches in `v2/src/isolated-instance-config.ts` to propagate more.

## Deployment (generic Ubuntu VM)

- VM: Ubuntu host with private Tailscale IP such as `100.64.0.10`
- Nothing binds to `0.0.0.0`. All services on loopback or Tailscale IP only.
- Instance config: `~/.spur/config.yaml`
- Project config: `~/projects/spur/spur.yaml`

Port map:

| Service | Bind address | Port |
|---------|-------------|------|
| Daemon API | `127.0.0.1` | 4310 |
| Next.js (web) | `127.0.0.1` | 3012 |
| Nginx proxy | `127.0.0.1` + private Tailscale IP | 5555 |

- Systemd units: `spur-daemon.service`, `spur-web.service`
- Nginx config: `/etc/nginx/sites-enabled/spur`
- Deploy: `pnpm main:deploy` (pulls main, builds, restarts services)
- Terminal WS shares the web server on path `/ws` (no separate port). Any reverse proxy that forwards `/` covers it; no `DIRECT_TERMINAL_*` env to keep in sync.
- Full deploy doc: `docs/install-from-source.md`

## Validation

Three tiers; pick the cheapest that crosses the changed boundary:

| Tier | Command | Triggers |
|---|---|---|
| `fast` | `pnpm --dir v2 test` | every Spur code change; queueing, dedupe, validation logic |
| `runtime integration` | `pnpm --dir v2 test:runtime` | CLI, daemon startup, client transport, session lifecycle, worktree setup, `tmux`, automation runtime; source and process boundaries |
| `real-agent smoke` | `pnpm --dir v2 test:smoke` | agent launch or prompt delivery; against this repo with real `claude`, `codex`, and `cursor` (never fake repos or agents). Auto-skips when `tmux`, binaries, or API keys are missing |

- Always run `pnpm --dir v2 build` after changing Spur code.
- Minimum per touched command: positive path, negative/error path, cleanup verification.
- Daemon startup or client transport changes -> `runtime integration` must cover both direct daemon start and CLI auto-start.
- Workspace or runtime behavior changes -> `runtime integration` must cover worktree creation, symlinks, `tmux` session creation, message delivery, teardown.
- `tester` also flags hanging logic, stray fallbacks outside boundary/cleanup paths, and loose or bloated type shapes in touched Spur code.
