# Commands

CLI reference. Config fields live in [configuration.md](configuration.md).

## Surface

`doctor`, `spawn`, `shepherd`, `wake`, `list`, `connect`, `disconnect`, `send`, `pause`, `complete`, `kill`, `respawn`, `reopen`, `service`, `memory`. `daemon start`, `daemon stop`, `daemon restart`, `slots`, `self-destruct`, and `sidecar` are internal and hidden from `--help`.

Run from source with `node v2/dist/cli.js <cmd>` after `pnpm --dir v2 build`.

## doctor

Read-only. Checks host install, config validity, and daemon/web health; exits non-zero on a broken (not merely un-initialized) host. Writes no config or state. `--scaffold` writes a minimal local `spur.yaml` at the repo root when none exists — it still does not start the daemon or create `~/.spur/config.yaml`. The global config and local project auto-connect on the first normal command.

## spawn

```bash
spur spawn <project> [prompt...] [--agent claude|codex|cursor] [--model <id>] [--plan] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared]
```

Takes a task prompt, or starts an empty agent session. Optional `steps` are a pipeline skeleton around the task.

- `[prompt...]` optional. Empty opens the session without an initial message and skips default `spawn.steps`.
- `--step <label>` appends a manual pipeline phase; repeat for more.
- `--plan` enables plan-mode startup, disables configured/manual steps, and appends a planning-only instruction. Claude adds `--permission-mode plan`; Cursor uses `--plan`; Codex accepts the flag with launch behavior unchanged.
- `--model <id>` applies to the resolved agent on fresh launch. Ids come from claude aliases (opus/sonnet/haiku/fable), codex `models_cache.json` under `CODEX_HOME`, or `agent models` for cursor.
- Spur sends the next phase only after the agent returns to its prompt, then waits 30s before auto-sending.
- Project configs set default `spawn.steps`; manual/API/trigger steps override.

```bash
spur spawn backend-api "Fix the flaky auth test"
spur spawn backend-api "Fix the flaky auth test" --step research --step test
spur spawn backend-api
```

Agents launch with full access: `claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`.

Preflight is opt-in. When `projects.<id>.preflight` is set and `spawn` gets no `--branch`, Spur asks the agent for one branch name (or `NO_PROJECT_RULES` / empty to defer to default naming) before worktree creation. An invalid or already-checked-out suggestion is fed back for retry, up to three attempts. Explicit `--branch` stays strict and rejects a conflict with the conflicting worktree path.

New worktree branches fetch `origin`, fast-forward the base branch when only behind, and branch from the freshest remote ref. Override the base per session with `--worktree <defaultBranch>`.

## shepherd, wake

```bash
spur shepherd [prompt...]
spur wake <sessionId> --in 10m [message...]
spur wake <sessionId> --at <iso-time> [message...]
spur wake <sessionId> --daily-at 09:00,17:00 --until "done condition" [message...]
```

`shepherd` opens Spur's built-in manager session: `Shepherd` project, Claude in shared workspace, orchestration-only prompt (inspect state, use `$manager`, coordinate agents, no product code unless the operator asks for a config edit).

`wake` stores a delayed or recurring message; the daemon delivers when due, so a session can schedule its own next check. Daily wakes use daemon-local `HH:MM` and require `--until`.

## list

TTY opens a live selector: `Enter` attach in place, `l` log view, `p` pause, `c` complete, `r` restore, `k` kill, `Esc` quit. `Ctrl+G` returns to the selector. Non-TTY prints a one-shot summary.

Hides `completed` and `killed` by default. Derives live `state` and `lastActivityAt` from `tmux` plus native Claude/Codex signals. The log view combines key session events with a live tail of the main agent pane.

`pause` keeps the worktree; `complete` and `kill` remove owned artifacts but persist different statuses. Shared-workspace sessions keep the project path on `kill` and are not restorable.

`reopen <sessionId>` restarts a `completed` session in place — same id, same worktree path, native conversation resumed, original prompt not resent; it refuses when the branch is gone (use `respawn`) and does not bring back the Telegram binding, session artifacts, or sidecar ports.

While an agent is busy, manual `send` queues per session and flushes when it returns to a prompt, ahead of the next auto-step. For a `stopped`/`paused` worktree session, `send` first tries to resume the native Claude/Codex conversation, then falls back to a fresh launch.

Spur appends lifecycle events to `<dataDir>/events.jsonl` (recover checks, native-resume failures, fresh-launch fallbacks, step delivery).

## spur-slots

On each live session's `PATH`. Updates the tmux status-line title and named links stored with the session:

```bash
spur-slots --title "Fix flaky auth test"
spur-slots --link pr=https://github.com/org/repo/pull/45 --link tracker=https://tracker.example.com/TASK-123
```

## service

Each live session gets a `spur` wrapper on `PATH`, bound to that session's config, for session-bound sidecars:

```bash
spur service run web --port 3000 -- pnpm dev
spur service logs
spur service status api-a1b2
```

`service run` reads `SPUR_SESSION`, starts the command in a separate tmux sidecar, and stores metadata under the data dir. Stop/restart is not managed yet — the service stays bound while the session is alive. Pass `--port` so `list` can surface it. Sidecar/service output also lands in the session event log for `spur service logs` and `/sessions/:id/logs`.

## memory

```bash
spur memory set|get|list|rm [key] [body] --scope task|project|global [--session <id>] [--file <path>] [--json]
```

Shared markdown memory: one `.md` file per key, body only, no tags/status/timestamps. `set` creates or overwrites. `list`/`get`/`rm` read or remove. Session id defaults to `SPUR_SESSION`; pass `--session` from outside a live session. `set` takes the body positional or `--file <path>` for multiline content — never both, never neither.

Scopes resolve server-side from the caller's session, never from client input:

- `task` — `<dataDir>/memory/task/<deskId ?? sessionId>/<key>.md`, shared across desk-group siblings.
- `project` — `<dataDir>/memory/project/<projectId>/<key>.md`, shared across all sessions of a project.
- `global` — `<dataDir>/memory/global/<key>.md`, one cell set for the whole Spur instance.

Writes are atomic (tmp file + rename) but unlocked — concurrent `set` on the same key is last-writer-wins.

Spawn prompt tells agents to read `task`/`project` on start and write durable, high-value facts only (business decisions, gotchas, user preferences) — not scratch, logs, or restated docs.

## Sidecars

For repo testing prefer `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>` over direct `pnpm dev` / `next dev`. It starts a configured sidecar from `projects.<id>.sidecars`. In this repo, `isolated-daemon` starts an isolated Spur daemon and `isolated-ui` starts the web UI against it, publishing a `sidecar-ui` link. `isolated-ui` uses its own Next `distDir` so its cache stays isolated from normal `packages/web` runs. New isolated worktrees inherit the current `spur.yaml`, agent instructions, and `.env` via the config overlay plus symlinks.

`autoStart` applies only when the main session spawns. Starting a sidecar from inside a sidecar is always manual, and nesting stops after one level (`session -> sidecar -> nested sidecar`). Nested sidecars never auto-start.

Sidecar `ports` are reserved and probed on the host at start and injected into the sidecar env, so siblings and unrelated processes cannot race the range.

Commands run through `sh -lc` with no `exec`, so login-shell init still applies and a sidecar command may start with `VAR=value ...`. `/bin/sh` is `dash` on Debian/Ubuntu, so `source` and nvm's own bashisms are unavailable inline — invoke `bash` explicitly for anything that needs nvm, e.g. a `bash`-shebang script or `bash -lc '. "$SPUR_REAL_HOME/.nvm/nvm.sh" && nvm use <v> && ...'`. If the launching agent's sandbox remaps `$HOME` to a scratch dir, the sidecar inherits it — use `$SPUR_REAL_HOME` (resolved from `/etc/passwd`) to reach the real home.

Sidecars, project services, and the Claude OAuth login pane do NOT inherit the agent session's npm prefix pin (`NPM_CONFIG_PREFIX`/`npm_config_prefix`/`NPM_CONFIG_GLOBALCONFIG`/`npm_config_globalconfig`/`PREFIX` are all stripped) so they can source `~/.nvm/nvm.sh` without tripping nvm's own incompatibility guards. A sidecar's own `npm run`/`npx` invocations still re-export `npm_config_prefix` to their children regardless (vanilla npm behavior), which can trip nvm one level down inside those children.

### Built-in MCP sidecars

A sidecar entry can carry MCP wiring, injecting its reserved port into the launching agent's MCP
config (claude `mcp-config.json`, codex `config.toml [mcp_servers.*]`) before launch. `playwright`
is the one built-in: a Spur-owned HTTP playwright MCP sidecar (headless browser tooling) for
claude/codex sessions, never cursor, off by default. Opt a project in with:

```yaml
sidecars:
  playwright:
    autoStart: true
```

Command, ports, and MCP wiring are code-only defaults (see `v2/src/sidecars/`); YAML only overrides
`autoStart` — a built-in entry rejects any other key, including `dependsOn`: MCP sidecars start
before the agent launches, ahead of the dependency-aware autostart pass, so a dependency on it
could never be satisfied. Enablement re-resolves from config at every spawn/restore/recover — no
per-session toggle, no `spur playwright` command.

Enabling an MCP sidecar for claude changes MCP resolution for the whole session: claude launches
with `--mcp-config <path> --strict-mcp-config`, so only servers Spur pre-merged into that generated
config survive — the merge reads `~/.claude.json` user-scope servers, `~/.claude.json`
`projects["<worktree path>"]`, and `<worktree>/.mcp.json`. A fresh worktree has no
`projects["<worktree path>"]` entry yet, so local-scope servers approved against the main repo path
are dropped for that session. A host `mcpServers.playwright` entry (from any of those three sources)
is silently replaced by Spur's own.

## build, daemon

```bash
pnpm --dir v2 build
```

`build` also restarts a running daemon when Spur config is discoverable. Spur keeps a durable config registry in `dataDir`: any normal CLI command syncs its `--config` into the daemon, and daemon boot reloads every registered path, rehydrates session state, resumes pipelines, and restarts sources/triggers. Attached configs must agree on `server.host`, `server.port`, `dataDir`, and `worktreeDir`; their project ids and `sessionPrefix` values stay globally unique per daemon.

## Validate

```bash
pnpm --dir v2 test            # fast (mocked, in-process)
pnpm --dir v2 test:runtime    # runtime integration (CLI, tmux, worktree, process boundaries)
pnpm --dir v2 test:smoke      # real-agent smoke against this repo (skips if tmux/binaries/auth missing)
```

Run `test:runtime` when touching CLI, daemon, transport, session lifecycle, worktree, or tmux. Run `test:smoke` when touching agent launch or prompt delivery.
