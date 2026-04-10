# Spur

Local daemon + CLI orchestrator.

- Spawns agents (`claude` / `codex`) in `tmux` sessions, using either an owned `git worktree` or the shared project path
- Watches sources (`cron`, `github`, `service`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

No UI. No tracker flow. No plugin layer.

## Commands

`spawn`, `list`, `send`, `pause`, `complete`, `kill`, `service`. `daemon start`, `daemon stop`, `daemon restart`, and `slots` are internal and hidden from `--help`.

```bash
spur spawn <project> [prompt...] [--agent claude|codex] [--plan] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared]
```

`spawn` can take a task prompt, or it can start an empty agent session. Optional `steps` are a pipeline skeleton around that task:

- The positional `[prompt...]` is optional. Leave it empty to open the agent session without sending an initial message.
- `--step <label>` appends manual pipeline phases; repeat it to add more than one.
- `--plan` enables plan-mode startup for the session. Claude startup adds `--permission-mode plan`; Codex accepts the flag but launch behavior stays unchanged.
- `steps` are optional phase labels such as `research`, `develop`, `test`.
- Spur sends the next phase only after the agent returns to its prompt, then waits 30 seconds before auto-sending it.
- Project configs can set default `spawn.steps`, and manual/API/trigger steps override that default.
- Empty prompt spawn skips both the initial message and any default `spawn.steps`, so the session opens blank.
- Trigger configs use `spawn.prompt` plus optional `spawn.steps`.

```bash
spur spawn backend-api "Fix the flaky auth test"
spur spawn backend-api "Fix the flaky auth test" --step research --step test
spur spawn backend-api
```

```yaml
spawn:
  prompt: "Review open PRs"
  steps:
    - "research"
    - "develop"
    - "test"
```

When `steps` are present, Spur sends messages like "step 1/N: research" plus the original task prompt. Without `steps`, Spur sends the task prompt as-is. With an empty prompt, Spur just opens the session and waits at the agent prompt.

`list` on a TTY opens a live selector: `Enter` attaches in place, `l` opens the selected session's live log view, `p` pause, `c` complete, `r` restore, `k` kill, `Esc` quit. `Ctrl+G` returns from either attach target or the log view back to the selector. Non-TTY prints a one-shot summary.

`list` hides `completed` and `killed` sessions by default.
`pause` stops the runtime but keeps the worktree. `complete` and `kill` both stop the runtime and remove owned artifacts, but persist different statuses for later filtering.

`list` derives live `state` and `lastActivityAt` from `tmux` plus native Claude/Codex activity signals.
While the agent is busy, manual `send` requests queue per session and flush after the agent returns to a prompt. Queued manual sends run before the next auto-step in a pipelined session.
When a worktree-backed session is `stopped` or `paused`, `send` first tries to resume the same native Claude/Codex conversation in the existing worktree using a stored or re-discovered agent session id, then falls back to a fresh launch if native resume is unavailable or stale.
Spur appends structured lifecycle events to `<dataDir>/events.jsonl`, including recover checks, native resume failures, fresh-launch fallbacks, and pipeline step delivery.
The `list` log view combines those key session events with a live tail of the main agent tmux pane for the selected session.

Agents run with full access:

- `claude --dangerously-skip-permissions`
- `codex --dangerously-bypass-approvals-and-sandbox`

Project spawn preflight is opt-in. If `projects.<id>.preflight` is set and `spawn` does not receive `--branch`, Spur asks the selected agent one-shot before worktree creation. The agent must return exactly one branch name, or `NO_PROJECT_RULES` to defer to Spur's default branch naming.

Each live session also gets a `spur-slots` helper command on its shell `PATH`.
Use it inside the session to update the task title and any named links shown in the tmux status line. In attached tmux sessions, clicking a status-right link label opens its URL:

```bash
spur-slots --title "Fix flaky auth test"
spur-slots --link tracker=https://tracker.example.com/TASK-123 --link pr=https://github.com/org/repo/pull/45
spur-slots --link design=https://figma.com/...
```

Each live session also gets a `spur` wrapper on its shell `PATH`, bound to that session's config.
Use it from inside the session workspace when the agent needs to start a session-bound sidecar:

```bash
spur service run web --port 3000 -- pnpm dev
spur service status api-a1b2
```

`service run` is session-bound: it reads `SPUR_SESSION`, starts the command in a separate `tmux` sidecar, and stores metadata under Spur's data dir. Spur does not manage stop/restart yet; the service simply stays bound to the session while it is alive.
If the agent already knows the devserver port, pass it with `--port` so `list` can surface it.

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
node dist/cli.js pause api-a1b2 --config spur.yaml
node dist/cli.js complete api-a1b2 --config spur.yaml
node dist/cli.js send api-a1b2 "Run the focused test and report back." --config spur.yaml
```

## Voice Input

Voice input lets you dictate prompts and messages in the web UI via a microphone button (spawn modal, session message box, terminal controls).

### Server dependencies

```bash
# whisper_cpp provider dependencies
git clone --depth 1 https://github.com/ggerganov/whisper.cpp /tmp/whisper.cpp
cd /tmp/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)
sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cli

# ffmpeg is required for whisper_cpp audio conversion
sudo apt install -y ffmpeg   # or brew install ffmpeg

# whisper_cpp default model
mkdir -p ~/.cache/whisper.cpp
curl -L -o ~/.cache/whisper.cpp/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# faster_whisper provider dependencies
python3 -m venv ~/.spur/venvs/faster-whisper
~/.spur/venvs/faster-whisper/bin/python -m pip install --upgrade pip faster-whisper
```

### Config

In `~/.spur/config.yaml`:

```yaml
voice:
  provider: whisper_cpp   # default: whisper_cpp
  language: auto          # default: auto
  model: base             # default: base
  # modelPath: ~/.cache/whisper.cpp/ggml-base.bin  # optional override
```

`voice.modelPath` has priority when set. If omitted, Spur uses `voice.model`.
For `whisper_cpp`, `voice.language` is passed as `-l <code>` to `whisper-cli`.
For `faster_whisper`, `voice.language` is used as the transcription language hint.
Spur auto-detects `~/.spur/venvs/faster-whisper/bin/python` when present, and uses `int8` by default for the faster-whisper worker.

### HTTPS requirement

Browsers require HTTPS for microphone access (`getUserMedia`). On `localhost` it works over plain HTTP. For remote access via Tailscale:

```bash
sudo tailscale serve --bg --https 443 http://127.0.0.1:5555
# Access at: https://<hostname>.tail90e846.ts.net/
# Only reachable within the tailnet.
# To disable: tailscale serve --https=443 off
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
- `github` emits `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`
- `service` emits `service:<ruleId>` when a bound service log tail matches a configured regex rule
- triggers either `spawn` a new session or `send` into an existing one

`github` polls running sessions, matches each to a PR branch, and emits only changed signals. State persists under `dataDir` across restarts.

`send.interrupt`:

- `false`: queue while `working`/`needs_input`, dedupe, flush when `waiting`
- `true`: interrupt immediately while `working`; `needs_input` still queues

`send.prompt` (GitHub send triggers):

- optional custom action text appended after the PR signal summary
- when set, replaces Spur's built-in GitHub action lines for that delivery

## Config

Spur now has two config layers:

- global instance config: `~/.spur/config.yaml` by default. This owns daemon host/port, data dirs, tmux socket, default agent, and UI port.
- local project config: nearest `spur.yaml` / `spur.yml`. This owns only `projects:`.

`spur list` and `spur spawn` auto-initialize the global instance config when missing and auto-connect the nearest local project config when present.
Voice input in `packages/web` is disabled until provider-specific voice dependencies are installed (`whisper-cli` + `ffmpeg` for `whisper_cpp`, Python + `faster-whisper` for `faster_whisper`). See [Voice Input](#voice-input) for setup.

```yaml
server:
  port: 4310

dataDir: ~/.spur
worktreeDir: ~/.spur/worktrees
defaultAgent: claude
tmux:
  socketName: spur-4310
ui:
  port: 5555
voice:
  provider: whisper_cpp
  language: auto
  model: base

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
          prompt: "Run $manager and $github. Address the latest requested review changes on the active PR."
      pr-watch-ci-failed:
        source: pr-watch
        event: github:ci_failed
        send:
          interrupt: true # delivered immediately and retried every 10m (up to 3) while CI still fails
          prompt: "Run $manager and $github. Check failing CI on the active PR, fix it, rerun relevant checks, then push."
      pr-watch-merge-conflict:
        source: pr-watch
        event: github:merge_conflict
        send:
          interrupt: false # one-shot when the PR becomes conflicting; can emit again after the conflict clears and returns
      pr-watch-comment:
        source: pr-watch
        event: github:comment
        send:
          interrupt: false # queued, deduped, flushed as one batch
          prompt: "Run $manager and $github. Review the latest PR comments on the active PR and address them."
      web-watch-crash:
        source: web-watch
        event: service:crash
        send:
          interrupt: false
```

Field reference:

- `server.host`: optional, default `127.0.0.1`.
- `server.port`: optional, default `4310`.
- `dataDir`: optional, default `~/.spur`.
- `worktreeDir`: optional, default `~/.spur/worktrees`.
- `defaultAgent`: optional, `claude|codex`, default `claude`.
- `voice.provider`: optional, `whisper_cpp|faster_whisper`, default `whisper_cpp`.
- `voice.language`: optional transcription language code, default `auto`.
- `voice.model`: optional model name, default `base`.
- `voice.modelPath`: optional local model path override. If set, it overrides `voice.model`.
- `projects.<id>.path`: required repo path.
- `projects.<id>.defaultBranch`: optional, default `main`.
- `projects.<id>.sessionPrefix`: optional, defaults to a sanitized `<id>`.
- `projects.<id>.worktree`: optional, default `true`.
- `projects.<id>.symlinks`: optional array of repo-relative paths, default `[]`.
- `projects.<id>.spawn.steps`: optional default phase list for project spawns; overridden by request or trigger `steps`.
- `projects.<id>.preflight`: optional preflight config object; enables one-shot branch suggestion before worktree creation.
- `projects.<id>.preflight.prompt`: optional one-shot branch-suggestion prompt; defaults to Spur's built-in rule-or-defer prompt when omitted.
- `projects.<id>.defaultAgent`: optional per-project `claude|codex`, falls back to top-level `defaultAgent`.
- `projects.<id>.sources.<sourceId>.type`: required, `cron|github|service`.
- `projects.<id>.sources.<sourceId>.runOnStart`: optional, default `false`.
- `projects.<id>.sources.<sourceId>.schedule`: required for `cron`.
- `projects.<id>.sources.<sourceId>.intervalMs`: optional for `github`, default `60000`.
- `projects.<id>.sources.<sourceId>.service`: required for `service`; logical id used by `spur service run <serviceId>`.
- `projects.<id>.sources.<sourceId>.intervalMs`: optional for `service`, default `2000`.
- `projects.<id>.sources.<sourceId>.tailLines`: optional for `service`, default `200`.
- `projects.<id>.sources.<sourceId>.rules.<ruleId>.match`: required regex string for `service`.
- `projects.<id>.sources.<sourceId>.rules.<ruleId>.clear`: optional regex string that clears the active problem state.
- `projects.<id>.sources.<sourceId>.rules.<ruleId>.cooldownMs`: optional for `service`, default `60000`.
- `projects.<id>.triggers.<triggerId>.source`: required source id.
- `projects.<id>.triggers.<triggerId>.event`: required event name.
- `projects.<id>.triggers.<triggerId>.spawn`: exactly one of `spawn` or `send` is required.
- `projects.<id>.triggers.<triggerId>.spawn.prompt`: required task prompt.
- `projects.<id>.triggers.<triggerId>.spawn.steps`: optional ordered phase list.
- `spawn --step <label>`: optional repeatable manual phase override for one CLI spawn.
- `spawn --plan`: optional CLI-only startup mode toggle. Claude startup enters plan mode; Codex currently accepts this flag but startup behavior is unchanged.
- `projects.<id>.triggers.<triggerId>.spawn.agent`: optional `claude|codex`.
- `projects.<id>.triggers.<triggerId>.spawn.branch`: optional explicit branch; bypasses preflight.
- `projects.<id>.triggers.<triggerId>.spawn.overrides.worktree`: optional boolean spawn override.
- `projects.<id>.triggers.<triggerId>.spawn.overrides.defaultBranch`: optional base-branch override, valid only with `worktree: true`.
- `projects.<id>.triggers.<triggerId>.send.interrupt`: optional boolean, default `false`.
- `projects.<id>.triggers.<triggerId>.send.prompt`: optional custom GitHub send action text; replaces built-in action lines when present.

Event surface:

- `cron` sources support only `cron:tick`.
- `github` sources support only `github:changes_requested`, `github:ci_failed`, `github:comment`, and `github:merge_conflict`.
- `service` sources support `service:<ruleId>` for each configured rule on that source.

`github:ci_failed` keeps one fixed retry policy in Spur: retry every 10 minutes, stop after 3 deliveries, and reset only after the failing CI signal disappears from the latest GitHub snapshot. With `send.interrupt: false`, each delivery waits for the session to return to `waiting`. With `send.interrupt: true`, Spur sends immediately even if the agent is still working.

`github:merge_conflict` is snapshot-based and one-shot: Spur emits it when the tracked PR becomes conflicting, clears it when the PR is mergeable again, and can emit it again later if conflicts return.

`projects.<id>.worktree` defaults to `true`. Set it to `false` to run in the project path instead of creating an owned `git worktree`.

`spawn` can override that default for one session with `--worktree` or `--shared`, and automation can do the same with `trigger.spawn.overrides.worktree`.

If `projects.<id>.preflight` is set, Spur runs a one-shot spawn preflight with the selected agent before worktree branch selection. Spur gives that preflight the project instructions plus the spawn task prompt. `preflight.prompt` is optional; when omitted Spur uses a built-in prompt that says to return only a branch name that follows the project rules, or `NO_PROJECT_RULES` when no branch-naming rules exist. If the preflight returns a branch name, Spur uses it. If it returns `NO_PROJECT_RULES`, Spur falls back to its default naming. `--branch` bypasses preflight.

When `spawn` creates a new worktree branch, it fetches `origin`, fast-forwards the configured base branch when it is only behind `origin/<branch>`, and uses the freshest remote-tracking ref available for the new worktree branch. Override the base branch per session with `--worktree <defaultBranch>` or `trigger.spawn.overrides.defaultBranch`.

Shared workspace sessions keep the project path intact on `kill` and are not restorable from `list`.
