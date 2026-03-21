# Spur

Local daemon + CLI orchestrator.

- Spawns agents (`claude` / `codex`) in `tmux` sessions, using either an owned `git worktree` or the shared project path
- Watches sources (`cron`, `github`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

No UI. No tracker flow. No plugin layer.

## Commands

`spawn`, `list`, `send`. `daemon start`, `daemon stop`, and `daemon restart` are internal and hidden from `--help`.

```bash
spur spawn <project> <prompt...> [--agent claude|codex] [--branch <name>] [--worktree [defaultBranch] | --shared]
```

`list` on a TTY opens a live selector: `Enter` attaches in place, `r` restore, `k` kill, `Esc` quit. Non-TTY prints a one-shot summary.

Agents run with full access:

- `claude --dangerously-skip-permissions`
- `codex --dangerously-bypass-approvals-and-sandbox`

Project spawn preflight is opt-in. If `projects.<id>.preflight.prompt` is set and `spawn` does not receive `--branch`, Spur asks the selected agent one-shot before worktree creation and uses `branch` when the preflight returns it.

Each live session also gets a `spur-slots` helper command on its shell `PATH`.
Use it inside the session to update the task title and any named links shown in the tmux status line:

```bash
spur-slots --title "Fix flaky auth test"
spur-slots --link tracker=https://tracker.example.com/TASK-123 --link pr=https://github.com/org/repo/pull/45
spur-slots --link design=https://figma.com/...
```

## Start

```bash
pnpm --dir v2 build
```

`build` also restarts a running daemon when Spur config is discoverable.

```bash
node dist/cli.js spawn backend-api "Fix the flaky auth test" --config spur.yaml
node dist/cli.js list --config spur.yaml
node dist/cli.js send api-1 "Run the focused test and report back." --config spur.yaml
```

## Validate

```
pnpm --dir v2 test            # fast (mocked, in-process)
pnpm --dir v2 test:runtime    # runtime integration (CLI, tmux, worktree, process boundaries)
pnpm --dir v2 test:smoke      # real-agent smoke on the real ao repo (skips if tmux/binaries/auth missing)
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

- `false`: queue while `working`/`needs_input`, dedupe, flush when `waiting`
- `true`: interrupt immediately while `working`; `needs_input` still queues

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
    worktree: true
    preflight:
      prompt: "Suggest a git branch name from the task and repo rules. Prefer tracker or PR identifiers when present."
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
        spawn: # spawns a new session every weekday at 9am
          agent: claude
          prompt: "Review all open PRs and continue the highest-priority one."
          overrides:
            worktree: true
      pr-watch-changes-requested:
        source: pr-watch
        event: github:changes_requested
        send:
          interrupt: false # queued until agent is waiting
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: true # delivered immediately and retried every 10m (up to 3) while CI still fails
      pr-watch-comment:
        source: pr-watch
        event: github:comment
        send:
          interrupt: false # queued, deduped, flushed as one batch
```

`github:ci_failed` keeps one fixed retry policy in Spur: retry every 10 minutes, stop after 3 deliveries, and reset only after the failing CI signal disappears from the latest GitHub snapshot. With `send.interrupt: false`, each delivery waits for the session to return to `waiting`. With `send.interrupt: true`, Spur sends immediately even if the agent is still working.

`projects.<id>.worktree` defaults to `true`. Set it to `false` to run in the project path instead of creating an owned `git worktree`.

`spawn` can override that default for one session with `--worktree` or `--shared`, and automation can do the same with `trigger.spawn.overrides.worktree`.

If `projects.<id>.preflight.prompt` is set, Spur runs a one-shot spawn preflight with the selected agent before worktree branch selection. Spur gives that preflight the project instructions plus the initial spawn prompt. If the preflight returns `{"branch":"..."}`, Spur uses it. `--branch` bypasses preflight.

When `spawn` creates a new worktree branch, it fetches `origin`, fast-forwards the configured base branch when it is only behind `origin/<branch>`, and uses the freshest remote-tracking ref available for the new worktree branch. Override the base branch per session with `--worktree <defaultBranch>` or `trigger.spawn.overrides.defaultBranch`.

Shared workspace sessions keep the project path intact on `kill` and are not restorable from `list`.
