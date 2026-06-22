---
name: spur
description: Use when working on Spur — its CLI, daemon, tmux/worktree session flow, cron sources/triggers, config shape, and validation rules.
---

# Spur

## Fixed facts

- Spur is CLI plus local HTTP daemon. `packages/web` is the only supported UI — a thin Next.js frontend over the daemon HTTP API that must not grow its own backend or runtime logic.
- Treat the Spur interface as fixed unless the user asks to change it.
- Discover the current human-facing command surface from `v2/src/cli.ts` and `spur --help`. Do not hard-code a command list in prompts. `daemon start` stays as the internal daemon command and is hidden from `spur --help`.
- `spawn` is positional: `spur spawn <project> [prompt...]` with optional `--agent claude|codex|cursor`, `--branch <name>`, repeatable `--step <label>`, and either `--worktree [defaultBranch]` or `--shared`. Empty prompt opens a blank session and skips default pipeline steps and initial message injection.
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
  backlog, no emit. `emitExisting: true` emits backlog once, capped at 10.
- `sentry` polls Sentry issues, emits `sentry:issue.new` per new issue. Shares work-item
  spawn/autoComplete lifecycle. First poll suppresses backlog unless `emitExisting: true`, capped at 10.
- `telegram` uses grammY runner long polling. Allowed chats/users can bind a chat or forum topic
  to a session with `/watch` picker or `/watch <sessionId>`; bound text emits `telegram:message`.
  Agents reply to the same Telegram target with `spur source reply "message"`.
- `runOnStart` defaults to `false`.

## Current config shape

```yaml
server:
  port: 4310

dataDir: ~/.spur
worktreeDir: ~/.spur-worktrees
defaultAgent: claude

projects:
  backend-api:
    path: ~/backend-api
    defaultBranch: main
    sessionPrefix: api
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
          steps:
            - "research"
            - "develop"
            - "run $code-simplifier"
            - "test"
```

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
- Prefer the smallest type shape that preserves safety. Concision beats type-level cleverness.
- Detect agent state and `Needs Input` from hook state and agent history JSONL for `claude` and `codex`. `cursor` currently uses pane/activity classification for readiness and state.
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
| Terminal WS | `127.0.0.1` | 14801 |
| Nginx proxy | `127.0.0.1` + private Tailscale IP | 5555 |

- Systemd units: `spur-daemon.service`, `spur-web.service`
- Nginx config: `/etc/nginx/sites-enabled/spur`
- Deploy: `pnpm main:deploy` (pulls main, builds, restarts services)
- `DIRECT_TERMINAL_PUBLIC_PORT=443` matches the external browser origin (Tailscale serve terminates TLS on 443 and forwards to nginx:5555), so the terminal WS URL stays same-origin.
- Full deploy doc: `docs/ubuntu-vm-deploy.md`

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
- `v2/TEST_SCENARIOS.md` maps each scenario to exactly one tier. Add new scenarios in the same change; rerun impacted ones. `tester` covers existing affected scenarios plus new ones.
- `tester` also flags hanging logic, stray fallbacks outside boundary/cleanup paths, and loose or bloated type shapes in touched Spur code.
