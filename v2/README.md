# Spur

Local daemon + CLI orchestrator.

- Spawns agents (`claude` / `codex`) in `tmux` sessions, using either an owned `git worktree` or the shared project path
- Watches sources (`cron`, `github`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

No UI. No tracker flow. No plugin layer.

## Commands

`spawn`, `list`, `send`, `pause`, `complete`, `kill`. `daemon start`, `daemon stop`, `daemon restart`, and `slots` are internal and hidden from `--help`.

```bash
spur spawn <project> <prompt...> [--agent claude|codex] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared]
```

`spawn` always takes one task prompt. Optional `steps` are a pipeline skeleton around that task:

- The positional `<prompt...>` is the task.
- `--step <label>` appends manual pipeline phases; repeat it to add more than one.
- `steps` are optional phase labels such as `research`, `develop`, `test`.
- Spur sends the next phase only after the agent returns to its prompt.
- Project configs can set default `spawn.steps`, and manual/API/trigger steps override that default.
- Trigger configs use `spawn.prompt` plus optional `spawn.steps`.

```bash
spur spawn backend-api "Fix the flaky auth test"
spur spawn backend-api "Fix the flaky auth test" --step research --step test
```

```yaml
spawn:
  prompt: "Review open PRs"
  steps:
    - "research"
    - "develop"
    - "test"
```

When `steps` are present, Spur sends messages like "step 1/N: research" plus the original task prompt. Without `steps`, Spur sends the task prompt as-is.

`list` on a TTY opens a live selector: `Enter` attaches in place, `p` pause, `c` complete, `r` restore, `k` kill, `Esc` quit. Non-TTY prints a one-shot summary.

`list` hides `completed` and `killed` sessions by default.
`pause` stops the runtime but keeps the worktree. `complete` and `kill` both stop the runtime and remove owned artifacts, but persist different statuses for later filtering.

`list` derives live `state` and `lastActivityAt` from `tmux`.
When a worktree-backed session is `stopped` or `paused`, `send` first tries to resume the same native Claude/Codex conversation in the existing worktree using a stored or re-discovered agent session id, then falls back to a fresh launch if native resume is unavailable or stale.
Spur appends structured lifecycle events to `<dataDir>/events.jsonl`, including recover checks, native resume failures, fresh-launch fallbacks, and pipeline step delivery.

Agents run with full access:

- `claude --dangerously-skip-permissions`
- `codex --dangerously-bypass-approvals-and-sandbox`

Project spawn preflight is opt-in. If `projects.<id>.preflight` is set and `spawn` does not receive `--branch`, Spur asks the selected agent one-shot before worktree creation. The agent must return exactly one branch name, or `NO_PROJECT_RULES` to defer to Spur's default branch naming.

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

Spur keeps a durable config registry in `dataDir`. Any normal CLI command syncs its current
`--config` into the running daemon, and daemon boot reloads every registered config path,
rehydrates durable session state, resumes running pipelines, and restarts configured
sources/triggers.

Attached configs must agree on `server.host`, `server.port`, `dataDir`, and `worktreeDir`, and
their `project` ids plus `sessionPrefix` values must stay globally unique within that daemon.

```bash
node dist/cli.js spawn backend-api "Fix the flaky auth test" --config spur.yaml
node dist/cli.js list --config spur.yaml
node dist/cli.js pause api-1 --config spur.yaml
node dist/cli.js complete api-1 --config spur.yaml
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
    spawn:
      steps:
        - "research"
        - "test"
    preflight: {} # optional: omit prompt to use Spur's default rule-or-defer prompt
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
          prompt: "Review all open PRs."
          steps:
            - "research"
            - "run $code-simplifier"
            - "continue implementation"
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

Field reference:

- `server.host`: optional, default `127.0.0.1`.
- `server.port`: optional, default `4310`.
- `dataDir`: optional, default `~/.spur`.
- `worktreeDir`: optional, default `~/.spur-worktrees`.
- `defaultAgent`: optional, `claude|codex`, default `claude`.
- `projects.<id>.path`: required repo path.
- `projects.<id>.defaultBranch`: optional, default `main`.
- `projects.<id>.sessionPrefix`: optional, defaults to a sanitized `<id>`.
- `projects.<id>.worktree`: optional, default `true`.
- `projects.<id>.symlinks`: optional array of repo-relative paths, default `[]`.
- `projects.<id>.spawn.steps`: optional default phase list for project spawns; overridden by request or trigger `steps`.
- `projects.<id>.preflight`: optional preflight config object; enables one-shot branch suggestion before worktree creation.
- `projects.<id>.preflight.prompt`: optional one-shot branch-suggestion prompt; defaults to Spur's built-in rule-or-defer prompt when omitted.
- `projects.<id>.defaultAgent`: optional per-project `claude|codex`, falls back to top-level `defaultAgent`.
- `projects.<id>.sources.<sourceId>.type`: required, `cron|github`.
- `projects.<id>.sources.<sourceId>.runOnStart`: optional, default `false`.
- `projects.<id>.sources.<sourceId>.schedule`: required for `cron`.
- `projects.<id>.sources.<sourceId>.intervalMs`: optional for `github`, default `60000`.
- `projects.<id>.triggers.<triggerId>.source`: required source id.
- `projects.<id>.triggers.<triggerId>.event`: required event name.
- `projects.<id>.triggers.<triggerId>.spawn`: exactly one of `spawn` or `send` is required.
- `projects.<id>.triggers.<triggerId>.spawn.prompt`: required task prompt.
- `projects.<id>.triggers.<triggerId>.spawn.steps`: optional ordered phase list.
- `spawn --step <label>`: optional repeatable manual phase override for one CLI spawn.
- `projects.<id>.triggers.<triggerId>.spawn.agent`: optional `claude|codex`.
- `projects.<id>.triggers.<triggerId>.spawn.branch`: optional explicit branch; bypasses preflight.
- `projects.<id>.triggers.<triggerId>.spawn.overrides.worktree`: optional boolean spawn override.
- `projects.<id>.triggers.<triggerId>.spawn.overrides.defaultBranch`: optional base-branch override, valid only with `worktree: true`.
- `projects.<id>.triggers.<triggerId>.send.interrupt`: optional boolean, default `false`.

Event surface:

- `cron` sources support only `cron:tick`.
- `github` sources support only `github:changes_requested`, `github:ci_failed`, and `github:comment`.

`github:ci_failed` keeps one fixed retry policy in Spur: retry every 10 minutes, stop after 3 deliveries, and reset only after the failing CI signal disappears from the latest GitHub snapshot. With `send.interrupt: false`, each delivery waits for the session to return to `waiting`. With `send.interrupt: true`, Spur sends immediately even if the agent is still working.

`projects.<id>.worktree` defaults to `true`. Set it to `false` to run in the project path instead of creating an owned `git worktree`.

`spawn` can override that default for one session with `--worktree` or `--shared`, and automation can do the same with `trigger.spawn.overrides.worktree`.

If `projects.<id>.preflight` is set, Spur runs a one-shot spawn preflight with the selected agent before worktree branch selection. Spur gives that preflight the project instructions plus the spawn task prompt. `preflight.prompt` is optional; when omitted Spur uses a built-in prompt that says to return only a branch name that follows the project rules, or `NO_PROJECT_RULES` when no branch-naming rules exist. If the preflight returns a branch name, Spur uses it. If it returns `NO_PROJECT_RULES`, Spur falls back to its default naming. `--branch` bypasses preflight.

When `spawn` creates a new worktree branch, it fetches `origin`, fast-forwards the configured base branch when it is only behind `origin/<branch>`, and uses the freshest remote-tracking ref available for the new worktree branch. Override the base branch per session with `--worktree <defaultBranch>` or `trigger.spawn.overrides.defaultBranch`.

Shared workspace sessions keep the project path intact on `kill` and are not restorable from `list`.
