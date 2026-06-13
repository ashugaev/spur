# Spur

Local daemon + CLI orchestrator.

- Spawns agents (`claude` / `codex` / `cursor`) in `tmux` sessions, using either an owned `git worktree` or the shared project path
- Watches sources (`cron`, `github`, `service`) and routes events to triggers
- Triggers either spawn a new session or send a message into an existing one

## Run From Source

```bash
pnpm --dir v2 build
node v2/dist/cli.js doctor
node v2/dist/cli.js list
node v2/dist/cli.js spawn <project> "Fix the flaky auth test"
```

First run in a repo you want Spur to manage:

```bash
spur doctor
spur list
spur spawn <project> "Fix the flaky auth test"
```

`spur doctor` writes a minimal local `spur.yaml` at the git repo root for the current checkout. It
does not call `connect`, does not start the daemon, and does not create `~/.spur/config.yaml`. The
first normal Spur command still auto-initializes that global instance config, and `spur list` /
`spur spawn` auto-connect the local project config through the existing config path.

If you are developing this repository itself, use `bash scripts/setup.sh` instead. Contributor bootstrap lives in [../SETUP.md](../SETUP.md).

## Local Project Config

`spur doctor` writes the same minimal shape shown below:

```yaml
projects:
  my-project:
    path: .
    defaultBranch: main
    sessionPrefix: my-project
```

Use [spur.yaml.example](./spur.yaml.example) as the copyable baseline. Add `symlinks`, `sources`,
`triggers`, `sidecars`, or agent overrides only when the repo needs them.

## Commands

`doctor`, `spawn`, `conductor`, `wake`, `list`, `connect`, `disconnect`, `send`, `pause`, `complete`, `kill`, `respawn`, `service`. `daemon start`, `daemon stop`, `daemon restart`, `slots`, and `sidecar` are internal and hidden from `--help`.

```bash
spur spawn <project> [prompt...] [--agent claude|codex|cursor] [--plan] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared]
```

`spawn` can take a task prompt, or it can start an empty agent session. Optional `steps` are a pipeline skeleton around that task:

- The positional `[prompt...]` is optional. Leave it empty to open the agent session without sending an initial message.
- `--step <label>` appends manual pipeline phases; repeat it to add more than one.
- `--plan` enables plan-mode startup for the session, disables configured/manual spawn steps, and appends a planning-only instruction to the task prompt. Claude startup adds `--permission-mode plan`; Cursor uses `--plan`; Codex accepts the flag but launch behavior stays unchanged.
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

```bash
spur conductor [prompt...]
spur wake <sessionId> --in 10m [message...]
spur wake <sessionId> --at <iso-time> [message...]
```

`conductor` starts or reopens Spur's built-in manager session. It uses the `Conductor` project, runs Claude in shared workspace mode, and gets an orchestration-only prompt: inspect state, use `$manager`, coordinate agents, and do not write product code unless the operator explicitly asks for a config edit. `wake` stores one delayed message on a session; the daemon delivers it when due, so conductor sessions can schedule their own next check.

```yaml
spawn:
  prompt: "Review open PRs"
  steps:
    - "research"
    - "develop"
    - "test"
```

When `steps` are present, Spur sends messages like "step 1/N: research" plus the original task prompt. Without `steps`, Spur sends the task prompt directly unless `--plan` is set, in which case it appends the planning-only instruction. With an empty prompt, Spur just opens the session and waits at the agent prompt.

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

Project spawn preflight is opt-in. If `projects.<id>.preflight` is set and `spawn` does not receive `--branch`, Spur asks the selected agent before worktree creation. The agent should return exactly one branch name, or `NO_PROJECT_RULES` to defer to Spur's default branch naming. Empty output also defers to Spur's default branch naming.
If that preflight-suggested branch is invalid or already checked out in another worktree, Spur gives that feedback back to preflight and retries before failing the spawn.
An explicit `--branch` stays strict and rejects the conflict with the conflicting worktree path.

Each live session also gets a `spur-slots` helper command on its shell `PATH`.
Use it inside the session to update the task title shown in the tmux status line and any named links stored with the session:

```bash
spur-slots --title "Fix flaky auth test"
spur-slots --link tracker=https://tracker.example.com/TASK-123 --link pr=https://github.com/org/repo/pull/45
spur-slots --link design=https://figma.com/...
```

Each live session also gets a `spur` wrapper on its shell `PATH`, bound to that session's config.
Use it from inside the session workspace when the agent needs to start a session-bound sidecar:

```bash
spur service run web --port 3000 -- pnpm dev
spur service logs
spur service logs "$SPUR_SESSION" web
spur service status api-a1b2
```

`service run` is session-bound: it reads `SPUR_SESSION`, starts the command in a separate `tmux` sidecar, and stores metadata under Spur's data dir. Spur does not manage stop/restart yet; the service simply stays bound to the session while it is alive.
If the agent already knows the service port, pass it with `--port` so `list` can surface it.
Spur also collects sidecar and service output into the session event log, so `spur service logs` and `/sessions/:id/logs` can inspect those runtime lines alongside the normal session log stream.

For repo testing, prefer the session helper at `"$SPUR_SESSION_TOOL_DIR/spur-sidecar"` over direct `pnpm dev` or `next dev` launches. Run `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>` to start a configured sidecar from `projects.<id>.sidecars`. In this repo, `isolated-daemon` starts an isolated Spur daemon and `isolated-ui` starts the web UI against that daemon, then publishes a `sidecar-ui` link back into the session. `isolated-ui` uses its own Next `distDir`, so its dev cache stays isolated from normal `packages/web` build/test runs. New isolated worktrees inherit the current worktree's `spur.yaml`, agent instructions, and `.env` through the isolated config overlay plus symlinks, so sidecar testing sees the same workspace-access settings as the active branch.

`autoStart` applies only when the main session spawns. From inside a sidecar, starting another sidecar is always manual through the same helper, and nesting stops after one more level: `session -> sidecar -> nested sidecar`. Nested sidecars never auto-start.

If a sidecar defines `ports`, Spur reserves those ports when that sidecar starts and injects them into the sidecar env. Reservation also probes each candidate port on the host, so sibling sessions and unrelated host processes cannot race onto the same port range before anything starts listening.

Spur commands run through `bash -lc`, so sidecar commands may start with `VAR=value other_cmd ...` and may rely on login-shell initialization. If the launching agent runs in a sandbox that remaps `$HOME` to a scratch directory (e.g. `/tmp/spur-runtime-*`), the sidecar inherits that `$HOME`. To reach the real user home from a sidecar command, use `$SPUR_REAL_HOME` — Spur resolves it from `/etc/passwd` and exports it into every session and sidecar env. For example: `source "$SPUR_REAL_HOME/.nvm/nvm.sh"` instead of `source "$HOME/.nvm/nvm.sh"`.

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

### Daemon restarts and session survival

Tmux sessions (agent workspaces) survive daemon restarts. The systemd unit
uses `KillMode=process` so that `systemctl restart` only stops the daemon's
node process — tmux and agents keep running. On startup the daemon calls
`applyConfig()` which re-discovers living sessions, resumes delivery loops
for queued messages and running pipelines, and restarts attention monitoring.

In-memory state that does not survive a restart:

- Trigger pending batches and retry counters (re-populated on next source poll)
- State classification cache (rebuilt within seconds)
- State history ring buffer (starts empty)

Unit templates live in `deploy/`. After editing, copy to
`/etc/systemd/system/` and run `systemctl daemon-reload`.

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

# azure_openai provider credentials
cat >> ~/.spur/.env <<'EOF'
AZURE_OPENAI_ENDPOINT=https://<resource>.services.ai.azure.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2024-10-21
EOF
chmod 600 ~/.spur/.env

# openai_compatible provider credentials (Groq example)
cat >> ~/.spur/.env <<'EOF'
GROQ_API_KEY=<key>
EOF
chmod 600 ~/.spur/.env
```

The `openai_compatible` provider talks to any vendor that exposes the OpenAI `POST /audio/transcriptions` shape. Pick a vendor, set `voice.baseUrl` and `voice.apiKey` (the **name** of the env var that holds the secret, not the secret itself), and put the matching key in `~/.spur/.env`:

| Vendor     | `voice.baseUrl`                  | `voice.apiKey`       | Example `voice.model`    |
| ---------- | -------------------------------- | -------------------- | ------------------------ |
| Groq       | `https://api.groq.com/openai/v1` | `GROQ_API_KEY`       | `whisper-large-v3-turbo` |
| OpenAI     | `https://api.openai.com/v1`      | `OPENAI_API_KEY`     | `whisper-1`              |
| OpenRouter | `https://openrouter.ai/api/v1`   | `OPENROUTER_API_KEY` | vendor-specific model id |

### Config

In `~/.spur/config.yaml`:

```yaml
voice:
  provider: whisper_cpp # default: whisper_cpp
  language: auto # default: auto
  model: base # default: base
  # modelPath: ~/.cache/whisper.cpp/ggml-base.bin  # optional override
```

`voice.modelPath` has priority when set. If omitted, Spur uses `voice.model`.
For `whisper_cpp`, `voice.language` is passed as `-l <code>` to `whisper-cli`.
For `faster_whisper`, `voice.language` is used as the transcription language hint.
For `azure_openai`, `voice.model` is the Azure deployment name, and credentials are read from `~/.spur/.env`.
For `openai_compatible`, `voice.baseUrl` and `voice.apiKey` are required; `voice.model` is the vendor's model id; the key is read from `~/.spur/.env` (or the environment) and never logged.
Spur auto-detects `~/.spur/venvs/faster-whisper/bin/python` when present, and uses `int8` by default for the faster-whisper worker.
Isolated daemons inherit `voice:` from `~/.spur/config.yaml`; relative `voice.modelPath` resolves against user config dir.

### HTTPS requirement

Browsers require HTTPS for microphone access (`getUserMedia`). On `localhost` it works over plain HTTP. For remote access via Tailscale (substitute your own tailnet, e.g. `tail1234.ts.net`):

```bash
sudo tailscale serve --bg --https 443 http://127.0.0.1:5555
# Access at: https://<hostname>.<your-tailnet>.ts.net/
# Only reachable within the tailnet.
# To disable: tailscale serve --https=443 off
```

## Validate

```
pnpm --dir v2 test            # fast (mocked, in-process)
pnpm --dir v2 test:runtime    # runtime integration (CLI, tmux, worktree, process boundaries)
pnpm --dir v2 test:smoke      # real-agent smoke against this repo (skips if tmux/binaries/auth missing)
```

Run `runtime integration` when touching CLI, daemon, transport, session lifecycle, worktree, or tmux.
Run `real-agent smoke` when touching agent launch or prompt delivery.
Scenarios: [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md)

## Automation

- `cron` emits `cron:tick`
- `github` emits `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`, and — when `query` is set on the source — `github:work_item.new` (one event per matching PR, ever)
- `service` emits `service:<ruleId>` when a bound service log tail matches a configured regex rule
- triggers either `spawn` a new session or `send` into an existing one

`github` polls running sessions, matches each to a PR branch, and emits only changed signals. State persists under `dataDir` across restarts.

When `query` is set, the same source also runs a second branch on the same `intervalMs`: it executes `gh search prs <query>`, emits `github:work_item.new` for each unseen PR, and persists the seen externalIds (`<owner>/<repo>#<n>`) in an append-only registry under `<dataDir>/source-state/github-work-items/`. One PR ↔ one Spur session, ever. No respawn on session death. At most one trigger per source may subscribe to `github:work_item.new` (parser rejects more). GitHub PR URLs seed the native `session.pr` binding; non-GitHub review URLs stay in `slots.links` with `label: "pr"`. Spawn prompts may reference work-item fields with `{{url}}`, `{{number}}`, `{{title}}`, `{{repo}}`, and `{{externalId}}`. When `spawn.autoComplete` is `true`, Spur stores the spawned session binding and completes it only after it has existed for at least five minutes and is in `waiting`; `working`, `needs_input`, paused, and spawning sessions block completion.

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
Voice input in `packages/web` is disabled until provider-specific voice dependencies are installed (`whisper-cli` + `ffmpeg` for `whisper_cpp`, Python + `faster-whisper` for `faster_whisper`, Azure credentials in `~/.spur/.env` for `azure_openai`, or `baseUrl`/`apiKey` plus a matching key in `~/.spur/.env` for `openai_compatible`). See [Voice Input](#voice-input) for setup.

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
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
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
      pr-review-queue:
        type: github
        intervalMs: 600000
        runOnStart: false
        # `gh search prs` query. One Spur session per matched PR, ever.
        query: "is:pr is:open repo:acme/backend-api label:needs-review"
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
      pr-review-queue-spawn:
        source: pr-review-queue
        event: github:work_item.new
        spawn:
          agent: claude
          prompt: "/code-review {{url}}"
          autoComplete: true
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
- `defaultAgent`: optional, `claude|codex|cursor`, default `claude`.
- `voice.provider`: optional, `whisper_cpp|faster_whisper|azure_openai|openai_compatible`, default `whisper_cpp`.
- `voice.language`: optional transcription language code, default `auto`.
- `voice.model`: optional model name, default `base`.
- `voice.modelPath`: optional local model path override. If set, it overrides `voice.model`.
- `voice.baseUrl`: required for `openai_compatible`; the vendor's OpenAI-compatible base URL (e.g. `https://api.groq.com/openai/v1`).
- `voice.apiKey`: name of the env var holding the API key (resolved from `~/.spur/.env` first, then `process.env`). Must match `^[A-Z][A-Z0-9_]*$`. **Required** for `openai_compatible`; **optional** for `azure_openai` (defaults to `AZURE_OPENAI_API_KEY`).
- `voice.endpoint`: optional for `azure_openai`; the Azure resource endpoint (e.g. `https://my-resource.openai.azure.com`). If unset, falls back to env var `AZURE_OPENAI_ENDPOINT`.
- `voice.apiVersion`: optional for `azure_openai`; API version string. If unset, falls back to env var `AZURE_OPENAI_API_VERSION`, then `2024-10-21`.
- `projects.<id>.path`: required repo path.
- `projects.<id>.defaultBranch`: optional, default `main`.
- `projects.<id>.sessionPrefix`: optional, defaults to a sanitized `<id>`.
- `projects.<id>.worktree`: optional, default `true`.
- `projects.<id>.symlinks`: optional array of repo-relative paths, default `[]`.
- `projects.<id>.branchNaming.regex`: optional JavaScript regex for branch names. Spur validates explicit, trigger, and preflight branches against it; sessions expose `spur-branch create|rename <name>` and block `git push` when the current branch does not match.
- `projects.<id>.spawn.steps`: optional default phase list for project spawns; overridden by request or trigger `steps`.
- `projects.<id>.preflight`: optional preflight config object; enables branch suggestion before worktree creation.
- `projects.<id>.preflight.prompt`: optional branch-suggestion prompt; defaults to Spur's built-in rule-or-defer prompt when omitted.
- `projects.<id>.defaultAgent`: optional per-project `claude|codex|cursor`, falls back to top-level `defaultAgent`.
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
- `spawn --plan`: optional CLI-only startup mode toggle. It disables configured/manual spawn steps, appends a planning-only instruction to the task prompt, makes Claude startup enter plan mode, uses `--plan` for Cursor, and leaves Codex launch behavior unchanged.
- `projects.<id>.triggers.<triggerId>.spawn.agent`: optional `claude|codex|cursor`.
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

If `projects.<id>.preflight` is set, Spur runs spawn preflight with the selected agent before worktree branch selection. Spur gives that preflight the project instructions plus the spawn task prompt. `preflight.prompt` is optional; when omitted Spur uses a built-in prompt that says to return only a branch name that follows the project rules, or `NO_PROJECT_RULES` when no branch-naming rules exist. If the preflight returns a branch name, Spur uses it. If the branch is invalid or already checked out elsewhere, Spur includes that feedback in the next preflight attempt and retries up to three total attempts. If it returns `NO_PROJECT_RULES` or empty output, Spur falls back to its default naming. `--branch` bypasses preflight.

When `spawn` creates a new worktree branch, it fetches `origin`, fast-forwards the configured base branch when it is only behind `origin/<branch>`, and uses the freshest remote-tracking ref available for the new worktree branch. Override the base branch per session with `--worktree <defaultBranch>` or `trigger.spawn.overrides.defaultBranch`.

Shared workspace sessions keep the project path intact on `kill` and are not restorable from `list`.
