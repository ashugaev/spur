# Spur Test Scenarios

Keep this file lean. Every new Spur scenario must live in exactly one tier.

## Tier Rules

- Always run `pnpm --dir v2 build` after Spur code changes.
- `fast` = `pnpm --dir v2 test`
  Default mocked and in-process coverage. This is the `v2` part of the normal root `pnpm test` path.
- `runtime integration` = `pnpm --dir v2 test:runtime`
  Uses the built CLI, daemon, `git`, worktree, `tmux`, and process boundaries with fake `claude`, `codex`, and `gh`.
- `real-agent smoke` = `pnpm --dir v2 test:smoke`
  Uses real `claude` and `codex` in Spur worktrees created from the real `ao` repo. It auto-skips when `tmux`, binaries, or agent auth are missing.
- Put each scenario in one tier only. If the boundary changes, move the scenario instead of duplicating it.

## Fast

- Root help exposes `spawn`, `list`, `send`, `pause`, `complete`, and `kill`, keeps the branded help output, and hides the internal `daemon` and `slots` commands.
- `list` subcommand help keeps the compact sections, inherited global options, and the TTY note for `p`, `c`, `r`, and `k`.
- In-process server returns runtime info and stops cleanly.
- `GET /sessions` keeps hiding terminal sessions by default, while `GET /sessions?includeCompleted=1` includes completed records for web consumers without changing CLI defaults or surfacing killed sessions in the dashboard.
- Client reuses a compatible daemon, auto-starts when unreachable, replaces an incompatible daemon, and surfaces JSON error payloads.
- Instance bootstrap auto-creates `~/.spur/config.yaml` when missing, applies defaults for daemon host/port, tmux socket, and UI port, and keeps local project discovery separate.
- Registry merges compatible config files into one daemon project set, materializes each project's effective default agent once, and rejects duplicate project ids or `sessionPrefix` values across registered configs.
- Config applies defaults once at the parse boundary for `server`, `defaultAgent`, project `worktree`, trigger spawn overrides, `runOnStart`, `intervalMs`, and `send.interrupt`.
- Config parses optional project `codexArgs`, and Codex spawn, resume, restore, and spawn preflight append those args through the single Codex launch path.
- Config applies service-source defaults once at the parse boundary for `intervalMs`, `tailLines`, and `rules.*.cooldownMs`, and validates `service:<ruleId>` trigger events against declared rule ids.
- Config rejects removed GitHub event names so the live GitHub surface stays `github:changes_requested`, `github:ci_failed`, `github:comment`, and `github:merge_conflict`.
- Config rejects duplicate `sessionPrefix` values across projects.
- Session service spawn follows one path: optional worktree spawn preflight, reserve id, resolve branch, create worktree, create `tmux`, wait for agent readiness, send the initial prompt, then persist the running record.
- Session-owned artifacts live under `dataDir/session-artifacts/<sessionId>`, are exposed on `SessionView.artifacts`, outbound message attachments are written there instead of the worktree, and cleanup removes them on failed spawn rollback, `complete`, and `kill`.
- Session service background spawn returns a persisted `spawning` placeholder first, then continues preflight, worktree, `tmux`, readiness, and initial prompt delivery in the background with up to 3 total attempts on the same session id.
- Background spawn retries clean up failed `tmux`, sidecar, hook-state, and worktree artifacts before the next attempt so one spawn request never leaves duplicate live processes.
- Background spawn keeps sync spawn branch-conflict behavior for explicit worktree branches and stops retrying after an initial prompt was already delivered so one request cannot duplicate agent work.
- `spawn` accepts an optional positional `[prompt...]`; empty prompt opens a blank session, skips preflight, and ignores default `spawn.steps`.
- `spawn --step <label>` repeats to override any configured project default `spawn.steps` for one manual session.
- `spawn --plan` disables request and project-default `spawn.steps`, so the agent receives only the raw task prompt.
- Config spawn triggers require `spawn.prompt` and may add optional `spawn.steps`.
- Config can define project default `spawn.steps`, and request or trigger steps override them instead of merging.
- Pipeline steps wrap one task prompt, then auto-send later phases in order after the agent returns to a prompt with a 30 second delay between auto-steps.
- Busy manual `send` requests queue per session, flush after the agent returns to a prompt, and stay ahead of the next pipeline step.
- Unfinished running pipelines resume after daemon restart without restarting the session.
- Worktree creation fetches `origin`, fast-forwards a clean checked-out local default branch that is purely behind, uses `origin/<defaultBranch>` as the new worktree base when that checked-out default branch is dirty and behind, creates explicit branches from `origin/<branch>` when needed, and fails fast when freshness cannot be proven.
- Session service can also spawn in a shared workspace when `worktree=false`, rejects branch overrides that would mutate the shared repo, skips worktree cleanup on kill, rejects restore for shared workspace sessions, and rejects `defaultBranch` overrides outside worktree mode.
- Opt-in project spawn preflight runs only for worktree spawns without an explicit `branch`, can use either an explicit `preflight.prompt` or Spur's default rule-or-defer prompt, treats empty output the same as the `NO_PROJECT_RULES` sentinel, accepts one non-empty branch name, and fails before reserving a session id when preflight output is otherwise invalid.
- `SessionService.preflight()` returns a suggested branch when the project has preflight config and worktree enabled.
- `SessionService.preflight()` returns null when worktree is disabled or the project has no preflight config.
- `SessionService.preflight()` rejects an empty prompt.
- Spawn creates compact session ids in the form `<prefix>-<hash4>` and retries on collisions before failing.
- Session lifecycle and trigger handling append structured key events to `dataDir/events.jsonl` for spawn, send, slot updates, kill, restore, and trigger match/deliver/drop paths.
- Successful worktree spawn preflight emits a session-scoped event so the selected session log view shows whether preflight chose a branch or deferred.
- Spawn captures Claude/Codex native session ids when the agent writes them to disk.
- Paused and crashed worktree-backed sessions can resume on later `send` by reusing stored native resume state when available, re-discovering it from agent state on disk when missing, and falling back to a fresh launch when native resume is stale.
- `list`, `send`, `pause`, `complete`, and `kill` target the exact tmux session name, so `spur-a1b2` never resolves to another same-prefix session.
- `codex` send delivery uses bracketed paste for the prompt text and a separate `Enter` submit, so multi-line prompt delivery does not depend on pasted newline characters being interpreted as submit.
- `list` hides `completed` and `killed` sessions by default while keeping `paused` sessions visible.
- `GET /projects` returns daemon-owned project labels, and explicit `connect` / `disconnect` mutate only the connected project-config registry.
- `GET /sessions/:id/artifacts/:artifactId` streams session-owned artifact bytes with inline disposition for images/videos and attachment disposition for download-only files.
- `pause` stops tmux, keeps the worktree, persists `paused`, and leaves slot metadata intact.
- `restore(sessionId)` keeps worktree-backed sessions restorable after both manual `pause` and unexpected agent stops; paused restore relaunches/resumes in place without sending any prompt, while unexpected-stop restore still delivers the restore prompt.
- `complete` stops tmux, removes owned artifacts, persists `completed`, and keeps the record available for later filtering.
- `kill` and `complete` still close an existing worktree-backed session after its project id is renamed in config, as long as the worktree still resolves back to the same repo, and `complete` also tears down any sidecar tmux/process cleanup owned by that session.
- Session slot updates keep one merge path: hidden CLI/API updates `title` plus named links, preserve session timestamps, expose the helper command inside the session env, and keep hidden commands out of `spur --help`.
- `list` and `ls` surface persisted slot associations as compact PR / tracker ids instead of full URLs, and TTY selected-session details show the same compact ids.
- Session setup injects both `spur-slots` and a session-bound `spur` wrapper into the helper tool dir, so in-session commands can call `spur service run ...` against the right config.
- `service run --port <n>` persists the port once, and `list` surfaces it in session details and one-shot summaries.
- `readSessionEventLog` still supports filtering runtime-style `sidecar.output` and `service.output` entries by scope and name when such entries exist, but Spur no longer appends them from `tmux`.
- `readEventLog` and `readSessionEventLog` stream the event log in chunks, so logs larger than Node's ~512 MiB single-string cap are read correctly, and `readSessionEventLog` with a `limit` bounds retained entries to the last N matches.
- `isHostPortFree` reports true for an unused port and false when another listener already holds the same port, so sidecar port reservation rejects host-level conflicts before handing a port to a sidecar.
- `startSidecar` fails loudly when the sidecar tmux pane dies immediately after launch, capturing the pane's last output in the error and killing the dead tmux session.
- Session and sidecar env include `SPUR_REAL_HOME` resolved from `/etc/passwd`, so sidecar commands can source files under the real user home even when the parent agent sandbox remaps `$HOME`.
- Service triggers batch by session, dedupe matched rule ids, and deliver only a problem notice plus the `spur list` log-view hint for the bound session.
- Spawn failure after placeholder metadata cleans up `tmux` and worktree side effects and persists an errored record.
- Repeated kill on an already cleaned session stays idempotent and does not rewrite terminal metadata.
- Repeating the same manual status (`pause` or `complete`) stays idempotent and does not rewrite metadata.
- Codex submit ack polls session rollout jsonl files for the exact trimmed user message text, with a 60s timeout and one Enter key retry.
- Codex restore falls back to a fresh launch when no native resume state (thread id) is found, keeps the same worktree/session id, and still delivers the restore prompt.
- Claude restore falls back to a fresh launch when no native resume state (session id) is found, keeps the same worktree/session id, and still delivers the restore prompt.
- Session state classification collapses public session status to `working`, `waiting`, `needs_input`, `stopped`, `error`, and `killed`, using JSONL-based classification for Claude and hook-primary classification plus structured rollout JSONL fallback for Codex.
- Claude JSONL classifier: `classifyClaudeJsonlState` maps assistant+stop_reason→waiting, assistant+`AskUserQuestion` or `input.questions[]` metadata→immediate `needs_input`, user `tool_result` carrying a `tool_reference` to `AskUserQuestion`→immediate `needs_input`, assistant+other tool_use within the stale window→working, assistant+other tool_use past the stale window→needs_input, system/stop_hook_summary/file-history-snapshot→waiting, other user records→working, progress→working, empty→working. The stale window is `TOOL_USE_STALE_MS` (3s) by default, extended by `input.timeout` when the tool declares one, and the window is bypassed entirely when the tool sets `input.run_in_background: true`. The optional `fileMtimeMs` argument is treated as last-observed activity and keeps the classifier on `working` while the JSONL is still being written.
- Claude JSONL reader: `readClaudeJsonlState` reads incrementally from the session JSONL file, skips re-read when mtime unchanged, and returns null when no JSONL file exists.
- Codex hook-based state: hook state is used only for state classification (not for submit ack); explicit hook `state` values or structured question metadata may set `needs_input`, no hook state defaults to `waiting`, and rollout JSONL can override stale hook snapshots with `task_complete`→`waiting` or structured question markers (`input_required`, `request_user_input`)→`needs_input`.
- Claude sessions skip hook state scripts (`spur-agent-state-updater.mjs`, `spur-agent-state`) and hook settings during spawn and recovery.
- State history records transitions per session in a ring buffer exposed via `SessionView.stateHistory`.
- Agent history fixture integrity: all Claude JSONL and Codex hook state fixtures match their SHA-256 manifest, are read-only (mode 444), and are not writable by the test process.
- Claude JSONL fixture classification covers waiting reasons from real history (end_turn, stop_sequence, system, stop_hook_summary, file-history-snapshot), all working sources (progress, user message, user tool_result, assistant streaming, fresh generic tool_use), needs_input (stale generic tool_use), declared-timeout Bash on real tails (spur-052a 900s budget, spur-0190 60s budget) both inside and past the budget, `run_in_background: true` Bash staying working regardless of age, real `AskUserQuestion` tails (spur-6e9a and spur-36e9) mapping directly to `needs_input`, and the `fileMtimeMs` anchor keeping `working` when the JSONL is still being touched past the declared budget.
- Codex hook state fixture classification covers real captured hook events: Stop→waiting, PreToolUse and PostToolUse→working, explicit `needs_input` hook payload support, structured question metadata mapping to `needs_input`, stale-hook recovery from a real `task_complete` tail, and `readAgentHookState` parsing from disk.
- TTY `list` surfaces `needs_input` prominently with a top alert and `!` row indicator.
- Session ordering keeps actionable sessions above quiet or terminal ones.
- GitHub send triggers deliver immediately when the target session is waiting.
- Busy GitHub updates queue, dedupe, drop entries that vanished from the latest source snapshot, and flush once the session returns to `waiting`.
- Manual queued sends flush one message at a time and enforce a minimum 15 second gap before the next queued delivery after `awaitingPrompt=true`.
- Manual send requests with `queue=false` bypass the queued stack and can still interrupt immediately when `interrupt=true`.
- `send.interrupt: true` interrupts immediately while working but does not repeatedly interrupt the same busy interval.
- `github:ci_failed` send triggers retry every 10 minutes while the failure signal persists, stop after 3 deliveries, wait for `waiting` when `send.interrupt=false`, and send immediately when `send.interrupt=true`.
- GitHub send triggers include built-in generic workflow hints plus event-specific next actions for review changes, CI failures, merge conflicts, and comments.
- GitHub send triggers can use `send.prompt` to replace the built-in workflow hints for that trigger.
- `cron` sources suppress ticks that arrive before the schedule's own cadence elapses, including `runOnStart` followed by a near-boundary scheduled tick.
- PR auto-detect piggybacks on the attention monitor to discover PRs by branch name via `gh pr list --head <branch>`, sets the `pr` slot automatically, skips sessions that already have a `pr` slot or no worktree, throttles `gh` calls to 30s, backs off after 5 checks in `waiting` with no state change, resets backoff on state change, and silently handles `gh` failures.
- `isGitHubEventData` and `isServiceProblemEventData` type guards accept valid shapes and reject null, missing fields, and wrong field types.
- `createSendBatchParser` dispatches `github` and `service` types to their batch parsers and returns a no-op for unknown types.
- GitHub send batch `merge` deduplicates signals by key and updates PR metadata; `prune` removes signals absent from the latest source snapshot; `format` includes PR number, title, signal texts, and kind-specific action lines (or a custom prompt override).
- Service send batch `merge` accumulates rule ids; `format` includes service id, sorted rule ids, and a custom prompt override.
- `shortText` collapses whitespace and truncates with ellipsis at a configurable limit.
- `parseRepoFromUrl` extracts `owner/repo` from GitHub PR URLs and returns empty for non-PR or invalid URLs.
- `normalizeReviewDecision` maps GitHub review decision strings to the internal enum and defaults to `none` for null, undefined, empty, or unknown values.
- `summarizeFailingCi` lists names of checks in any failing state and returns null when all pass.
- `hasMergeConflict` detects `CONFLICTING` mergeable or `DIRTY` merge state status.
- `normalizeLines` splits on newlines, trims trailing whitespace, and removes blank lines.
- `appendedLines` detects the overlap between previous and next line arrays and returns only the newly appended lines.
- `formatSessionLinkDisplay` extracts compact PR ids from GitHub URLs, Jira keys from tracker URLs, and falls back to the last path segment or label for unknown URL shapes.
- `appendEventLog` creates the data directory, writes JSONL entries, and auto-fills timestamps; `readEventLog` skips malformed lines; `readSessionEventLog` filters by session and respects a limit parameter.
- `extractCommandBinary` skips leading env-var assignments, handles single- and double-quoted binaries, and falls back when the command is empty.
- `parseAgentName` accepts `claude` and `codex` and throws for unsupported agent names.
- Codex preflight and runtime launch inject a `trust_level = "trusted"` entry for the relevant project path so fresh worktrees never hit the interactive "Do you trust..." prompt.

## Runtime Integration

- `list --json` auto-starts the daemon, auto-inits the global instance config when missing, auto-connects the nearest local project config when present, and returns `[]` on a fresh registry; `ls --json` does the same.
- `spawn` auto-inits the global instance config when missing and auto-connects the nearest local project config before project validation.
- `send`, `pause`, `complete`, `kill`, `service`, and hidden `daemon` commands use the global instance config but do not auto-connect a local project config.
- `spawn --json` creates a normal Spur session through the built CLI, with a real `git worktree`, configured symlinks, detached `tmux`, and fake agent launch.
- `spawn --json --agent codex` writes the spawned worktree path into the session-local `CODEX_HOME/config.toml` as `trusted`, so worktree launches stay non-interactive.
- `spawn --json` keeps one task prompt, and configured pipeline steps deliver ordered phases in the same session with a 30 second delay between auto-steps.
- `spawn --json` without `[prompt...]` creates a blank session, does not deliver an initial message, and does not apply default pipeline steps.
- `spawn --json --plan` ignores manual and configured spawn steps and sends only the raw prompt to the agent.
- `spawn --json` fetches `origin` before worktree creation, so a remote-advanced clean `main` lands in both the new Spur worktree and the local base branch.
- `spawn --json` with a dirty checked-out `main` still uses the fresh `origin/main` commit as the new worktree base and does not mutate local `main`.
- `spawn --json --worktree <defaultBranch>` creates a new worktree branch from the requested `defaultBranch` override through the built CLI.
- `spawn --json` can use an opt-in project spawn preflight through built `claude` and `codex` one-shot paths, and the returned branch becomes the live worktree branch.
- `spawn --json` falls back to the session id branch when a preflight-suggested branch is already checked out in another worktree, and `spawn --json --branch <name>` rejects that same conflict with the conflicting worktree path.
- Interactive spawn with preflight-enabled project calls `/projects/:id/preflight`, shows branch confirmation, and passes the confirmed branch in the spawn request.
- Non-TTY and `--json` spawn skip the preflight endpoint call.
- `POST /sessions/background` returns the placeholder session immediately, closes the web spawn modal on ack, and leaves the modal open when the daemon/API ack fails.
- `spawn --json` can also start a shared workspace session through the built CLI, keep the project path intact on kill, and reject `--shared --branch <name>` for a shared repo.
- `send --json` reaches the same `tmux`-backed session and the pane keeps both the initial prompt and the follow-up message.
- `send --json` queues while the fake agent is busy and delivers the queued message before the next pipeline step.
- `pause --json` stops runtime, keeps the worktree, keeps the session visible in `list --json`, and a later `send --json` can resume it in place.
- `complete --json` stops runtime, removes the owned worktree, persists `completed`, and disappears from `list --json`.
- `respawn --json` rejects running sessions, respawns a terminal session into a new running session, and keeps lifecycle cleanup available through normal `kill --json`.
- `respawn --json` preserves shared-workspace mode for shared sessions, preserves explicit branch targets, and falls back to a fresh session id branch when respawn preflight defers or picks an occupied worktree branch.
- `complete --json` and `kill --json` still work for sessions spawned under an old project id after the config renames that project to the same repo path, including sidecar cleanup on `complete --json`.
- `send --json` to a stopped or paused worktree-backed session resumes the same native Claude/Codex conversation when native state exists, otherwise relaunches in the same worktree and still delivers the message.
- The per-session `spur-slots` helper updates a live session title and named links through the hidden CLI/API path, refreshes `tmux` status hyperlinks without restarting the session, and keeps the status-right click binding pointed at the live URL opener.
- `service run` started from a session workspace creates a sidecar `tmux` session, `service status` inspects that live sidecar through the built CLI, and TTY `list` `l` opens a session log view with structured events while agent/runtime log output stays empty until a non-`tmux` log source exists.
- `service logs` currently returns structured runtime log entries only from the session event log, so service and sidecar output stay empty until a non-`tmux` log source exists; it still works inside a session workspace via the injected `spur` wrapper and rejects missing session context outside a Spur session.
- The hidden `sidecar start` CLI command starts a configured sidecar from the main session shell, allows one manual nested start from a first-level sidecar, and rejects callers already inside a nested sidecar.
- `POST /sessions/:id/sidecars/:name/start` follows the same depth rule as the hidden CLI command: root session and first-level sidecar callers may start a sidecar, while nested sidecars are rejected.
- Daemon startup, CLI session lifecycle, and automation source/trigger flows append structured key events to `dataDir/events.jsonl`.
- TTY `list` attaches in place on `Enter`, enables tmux mouse mode for scrollback, shows the `Ctrl+G detach` hint, and returns to the selector after detach.
- TTY `list` can pause, complete, and kill the selected live session in place; `completed` or `killed` sessions disappear from the live list without silently retargeting another row, and a killed session is not restorable on `Enter` or `r`, with terminal metadata showing `runtimeAlive: false` and `workspaceExists: false`.
- TTY `list` asks for confirmation before killing a session whose worktree has uncommitted changes or unpushed commits, and a second `k` forces the kill.
- TTY `list` can restore a stopped session in place, keep the same session id and worktree, use the agent CLI's native resume path when session state exists, deliver the restore prompt through `tmux` after an unexpected stop, and avoid sending any restore prompt after a manual pause.
- Session-bound `respawn --json` returns the replacement session, then completes the live calling session only when respawn succeeds.
- TTY `list` falls back to a fresh launch when the agent's native resume state is missing, keeps the same session id/worktree, and still delivers the restore prompt.
- Codex restore throws on ack timeout instead of falling back to a fresh launch.
- Daemon desktop notifications establish a startup baseline, notify once when a live session enters `needs_input` or `error`, and stay quiet until that attention state clears.
- `spawn` rejects an unknown project through the built CLI without creating session side effects.
- `send`, `pause`, `complete`, and `kill` reject an unknown session id through the built CLI.
- `send` rejects a `completed` or `killed` session through the built CLI.
- `POST /sessions/:id/kill` rejects a session whose worktree has uncommitted changes or unpushed commits unless `force: true`.
- `slots` rejects an unknown session id and malformed `--link label=url` input through the built CLI.
- Hidden `daemon stop --json` stops a running daemon and stays a no-op when it is already down or `/info` is incompatible without a Spur runtime pid.
- Hidden `daemon restart --json` replaces a live daemon and stays a no-op when it is already down or `/info` is incompatible without a Spur runtime pid.
- Restarting the daemon from a different compatible config path reloads every registered config from `dataDir`, so previously attached projects remain available after boot.
- Multiple daemon instances stay isolated by tmux socket name, so runtime sessions and web terminal attach target the selected Spur instance instead of the global default tmux server.
- `pnpm build` restarts a running daemon when `SPUR_CONFIG` or a nearby Spur config is available, and stays a no-op when no daemon is running or `/info` is incompatible without a Spur runtime pid.
- `ls` rejects unknown options through the built CLI.
- `cron` `runOnStart: true` emits on daemon boot and reaches the normal spawn flow without manual CLI input.
- `cron` `runOnStart: true` can also reach `trigger.spawn.prompt` plus optional `trigger.spawn.steps` and deliver the same ordered pipeline behavior as manual spawn.
- `cron` `runOnStart: true` can also reach the shared workspace path through `trigger.spawn.overrides.worktree: false`.
- GitHub source polling emits `github:comment` only when the stored snapshot changes for a running session with a matching PR branch.
- GitHub source polling plus send triggers deliver `github:ci_failed` into the live tmux-backed session when failing checks appear on the tracked PR.
- GitHub source polling emits `github:merge_conflict` only when the tracked PR becomes conflicting, clears it when the conflict disappears, and emits again if the conflict returns later.
- GitHub source polling plus send triggers deliver `github:merge_conflict` into the live tmux-backed session when merge conflicts appear on the tracked PR.
- Service sources currently do not emit `service:<ruleId>` until Spur has a non-`tmux` service log source.

- Claude agent status detection: spawn produces `waiting` (end_turn JSONL), `send` produces `working` (user JSONL), `show-waiting-menu` produces `needs_input` from `AskUserQuestion` JSONL metadata, and normal message exchange cycles waiting→working→waiting.
- Codex agent status detection: spawn produces `waiting` (Stop hook), `send` produces `working` (UserPromptSubmit hook), `show-waiting-menu` produces `needs_input` from structured hook/rollout state, stale `PreToolUse` snapshots are cleared by `task_complete`, and normal message exchange cycles waiting→working→waiting.
- Session-level states for both Claude and Codex: `pause`→stopped, `complete`→stopped, `kill`→killed, agent exit→stopped (runtime not alive).
- State history records transitions during a Claude session lifecycle.
- Sidecar auto-starts only on session spawn when `autoStart: true`; nested sidecars remain manual-only.
- Multiple sidecars per session get separate tmux panes.
- Sidecar cleanup on kill/complete/pause and failed spawn rollback.
- Manual sidecar start/stop via `spur sidecar start|stop --session <id> --name <name>`, and `start` also allows one nested hop through the injected `spur-sidecar` helper.
- Sidecar status reported in session view.

## Real-Agent Smoke

- `claude` launches as a real agent in a Spur worktree created from the real `ao` repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- `codex` launches as a real agent in a Spur worktree created from the real `ao` repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- Real `claude` and `codex` can also complete a staged task session in one worktree after returning to a prompt between phases.
- Real `claude` and `codex` can also satisfy an opt-in spawn preflight before the normal worktree session launch, and Spur uses the returned branch.
- Real `claude` and `codex` sessions can set `title` and named `links` through injected `spur-slots` instructions, and those slots survive `restore` in session metadata and tmux status.
- A real agent can open a disposable PR from its Spur worktree, then the same live session receives `github:comment` and `github:ci_failed`, and cleanup closes the PR, clears the temporary status/comment noise, and tears the session down cleanly.
- When a reviewer-capable second GitHub identity is available for the target repo, the same disposable-PR flow also receives `github:changes_requested` in the live session.

## Negative Paths

- Unknown project.
- Unsupported agent fails before session metadata, worktree, or tmux side effects.
- Missing prompt for `spawn`.
- Empty pipeline step in request or config.
- Empty branch.
- Missing session for `send`.
- Missing session for `pause`.
- Missing session for `complete`.
- Missing session for `kill`.
- Missing session for `respawn`.
- Empty message for `send`.
- `send` to a `completed` or `killed` session.
- `respawn` for a non-terminal session.
- `cron` source without `schedule`.
- Trigger spawn without `prompt`.
- Trigger referencing an unknown source.
- `service run` outside a live Spur session.
- `service status` for an unknown session id.

### Sidecars

**Tier: fast**

- `sidecars` config parsing: named sidecar entries with command, autoStart, env, reserved `ports`
- `devServer` backward compat: parsed as `sidecars.dev` with same command/autoStart
- Both `devServer` and `sidecars` defined: throws error
- Invalid sidecar reserved port ranges fail config validation
- Sidecar tmux session naming: `{sessionId}--{sidecarName}`
- `buildSessionEnv` includes `SPUR_SESSION_TOOL_DIR`, excludes `SPUR_CONFIG`
- Sidecar env merges session env with sidecar config env and sets `SPUR_SIDECAR_DEPTH`
- `ensureSessionSlotTool` creates `spur-sidecar` wrapper script

**Tier: runtime integration**

- Sidecar auto-starts only on session spawn when `autoStart: true`
- Multiple sidecars per session get separate tmux panes
- Reserved sidecar ports are assigned when a sidecar starts, injected into sidecar env, and released after cleanup
- Spawn continues when sidecar autostart cannot reserve a port; manual `sidecar start` fails fast until a port is released, then succeeds
- `isolated-daemon` writes isolated runtime artifacts and registry so sibling sidecars can target the isolated Spur daemon
- `isolated-ui` allocates a UI port, starts web against the isolated daemon, publishes `sidecar-ui` session link, and removes it on cleanup
- Sidecar cleanup on kill/complete/pause and failed spawn rollback
- Manual sidecar start/stop via `spur sidecar start|stop --session <id> --name <name>`
- Nested sidecars are manual-only through `spur-sidecar`, nesting stops after one extra level, and rejected depth overruns are logged
- Sidecar status reported in session view

## Regression Rule

- When a new Spur feature or failure mode is added, extend this file in the same change.
- For `v2/`-only changes, rerun the impacted tier scenarios and the touched CLI commands through positive and negative paths.
- For touched `v2/` code, also check hanging logic, stray fallbacks outside boundary and cleanup paths, and loose or bloated type shapes.
