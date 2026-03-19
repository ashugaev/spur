# Spur

Local daemon + CLI orchestrator.

- Spawns agents (`claude` / `codex`) in isolated `git worktree` + `tmux` sessions
- Watches sources (`cron`, `github`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

No UI. No tracker flow. No plugin layer.

## Commands

`spawn`, `list`, `send`. `daemon start` is internal — hidden from `--help`.

```bash
spur spawn <project> <prompt...> [--agent claude|codex] [--branch <name>]
```

`list` on a TTY opens a live selector: `Enter` attach, `r` restore, `k` kill, `Esc` quit. Non-TTY prints a one-shot summary.

Agents run with full access:
- `claude --dangerously-skip-permissions`
- `codex --dangerously-bypass-approvals-and-sandbox`

## Start

```bash
pnpm --dir v2 build
```

```bash
node dist/cli.js spawn backend-api "Fix the flaky auth test" --config spur.yaml
node dist/cli.js list --config spur.yaml
node dist/cli.js send api-1 "Run the focused test and report back." --config spur.yaml
```

## Validate

```
pnpm --dir v2 test            # fast (mocked, in-process)
pnpm --dir v2 test:runtime    # runtime integration (CLI, tmux, worktree, process boundaries)
pnpm --dir v2 test:smoke      # real-agent smoke (skips if binaries/keys missing)
```

Run `runtime integration` when touching CLI, daemon, transport, session lifecycle, worktree, or tmux.
Run `real-agent smoke` when touching agent launch or prompt delivery.
Scenarios: [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md)

## Automation

- `cron` emits `cron:tick`
- `github` emits `github:changes_requested`, `github:ci_failed`, `github:comment`
- triggers either `spawn` a new session or `send` into an existing one

`github` polls running sessions, matches each to a PR branch, and emits only changed signals. State persists under `dataDir` across restarts.

`send.interrupt`:
- `false`: queue while `active`/`waiting_input`, dedupe, flush when `ready`/`idle`
- `true`: interrupt immediately while `active`; `waiting_input` still queues

## Config

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
    triggers:
      weekday-review-spawn:
        source: weekday-review
        event: cron:tick
        spawn:                  # spawns a new session every weekday at 9am
          agent: claude
          prompt: "Review all open PRs and continue the highest-priority one."
      pr-watch-changes-requested:
        source: pr-watch
        event: github:changes_requested
        send:
          interrupt: false      # queued until agent is idle
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: true       # delivered immediately, even if agent is active
      pr-watch-comment:
        source: pr-watch
        event: github:comment
        send:
          interrupt: false      # queued, deduped, flushed as one batch
```
