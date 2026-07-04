# Spur Test Scenarios

Keep this file lean. Every new Spur scenario must live in exactly one tier.
Coverage means scenario coverage, not numeric line coverage. `tests/scenario-coverage.json` maps each scenario bullet here to the executable CI test tier that owns it.

## Tier Rules

- Always run `pnpm --dir v2 build` after Spur code changes.
- `fast` = `pnpm --dir v2 test`
  Default mocked and in-process coverage. This is the `v2` part of the normal root `pnpm test` path.
- `runtime integration` = `pnpm --dir v2 test:runtime`
  Uses the built CLI, daemon, `git`, worktree, `tmux`, and process boundaries with fake `claude`, `codex`, `cursor`, and `gh`.
- `real-agent smoke` = `pnpm --dir v2 test:smoke`
  Uses real `claude`, `codex`, and `cursor` in Spur worktrees created from this repo. It auto-skips when `tmux`, binaries, or agent auth are missing.
- Put each scenario in one tier only. If the boundary changes, move the scenario instead of duplicating it.

## Fast

- Root help also exposes `doctor`, and `doctor --help` explains the local scaffold plus the follow-up auto-connect flow through `list` or `spawn`.
- Root help exposes `doctor`, `spawn`, `shepherd`, `list`, `send`, `pause`, `complete`, `kill`, `respawn`, `session-memory`, and `service`, keeps the branded help output, and hides the internal `daemon`, `slots`, and `sidecar` commands.
- `list` subcommand help keeps the compact sections, inherited global options, and the TTY note for `p`, `c`, `r`, and `k`.
- In-process server returns runtime info and stops cleanly.
- `GET /sessions` keeps hiding terminal sessions by default, while `GET /sessions?includeCompleted=1` includes completed records for web consumers without changing CLI defaults or surfacing killed sessions in the dashboard.
- `GET /sessions?view=dashboard` returns a lean dashboard payload that keeps attention-critical fields plus `hasServiceIssues`, skips artifact/service/sidecar/workspace/state-history expansion, and still leaves `GET /sessions/:id` on the full detail shape.
- Client reuses a compatible daemon, auto-starts when unreachable, replaces an incompatible daemon, and surfaces JSON error payloads.
- Instance bootstrap auto-creates `~/.spur/config.yaml` when missing, applies defaults for daemon host/port, tmux socket, and UI port, and keeps local project discovery separate.
- `doctor` renders a minimal local `spur.yaml` at the git repo root, writes it without calling `connect`, does not create `~/.spur/config.yaml`, and refuses to overwrite an existing `spur.yaml` or `spur.yml`.
- Registry merges compatible config files into one daemon project set, materializes each project's effective default agent once, and rejects duplicate project ids or `sessionPrefix` values across registered configs.
- Config applies defaults once at the parse boundary for `server`, `defaultAgent`, project `worktree`, trigger spawn overrides, `runOnStart`, `intervalMs`, and `send.interrupt`.
- Config parses optional project `codexArgs`, and Codex spawn, resume, restore, and spawn preflight append those args through the single Codex launch path.
- Config defaults project `restoreAfterReboot` to false, parses an explicit true, and rejects non-boolean values at the parse boundary.
- Isolated sidecar project config rewrites matching project `path` and `defaultBranch` to the current worktree, and ensures new isolated worktrees symlink `.env`, `spur.yaml`, `AGENTS.md`, `CLAUDE.md`, `.agents`, and `.claude` from that source worktree.
- Config applies service-source defaults once at the parse boundary for `intervalMs`, `tailLines`, and `rules.*.cooldownMs`, and validates `service:<ruleId>` trigger events against declared rule ids.
- Config rejects removed GitHub event names so the live GitHub surface stays `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`, `github:ready_for_review`, `github:approved`, `github:merged`, `github:closed`, and `github:work_item.new` (the last only when `query` is set on the source).
- Config rejects duplicate `sessionPrefix` values across projects.
- Session service spawn follows one path: optional worktree spawn preflight, reserve id, resolve branch, create worktree, create `tmux`, wait for agent readiness, send the initial prompt, then persist the running record; branch naming policy rejects implicit fallback branches before worktree creation.
- Session-owned artifacts live under `dataDir/session-artifacts/<sessionId>`, are exposed on `SessionView.artifacts`, preserve `origin` plus a separate user-added signal, write outbound message attachments there instead of the worktree, and cleanup removes them on failed spawn rollback, `complete`, and `kill`.
- Session memory lives under `dataDir/session-memory/<sessionId>.json`, validates session ids and keys, persists sorted note records with active/resolved status, and is exposed only through `spur session-memory <sessionId> list|get|set|resolve` plus matching daemon routes.
- Spawn startup attachments are persisted as session artifacts and flow into the initial agent turn: image attachments use native Codex `--image` launch support, while non-image Codex startup attachments and all Claude startup attachments fall back to artifact-path references.
- Session service background spawn returns a persisted `spawning` placeholder first, then continues preflight, worktree, `tmux`, readiness, and initial prompt delivery in the background with up to 3 total attempts on the same session id.
- Spawn falls back to the session id when a resolved preflight or current worktree branch is already checked out elsewhere, and that conflict fallback does not re-apply branch-naming policy, so the session still spawns when project branch naming forbids the auto-generated session id (foreground and background paths).
- Background spawn retries clean up failed `tmux`, sidecar, hook-state, and worktree artifacts before the next attempt so one spawn request never leaves duplicate live processes.
- Background spawn keeps sync spawn branch-conflict behavior for explicit worktree branches and stops retrying after an initial prompt was already delivered so one request cannot duplicate agent work.
- `spawn` accepts an optional positional `[prompt...]`; empty prompt opens a blank session, skips preflight, and ignores default `spawn.steps`.
- `spawn --step <label>` repeats to override any configured project default `spawn.steps` for one manual session.
- `spawn --plan` disables request and project-default `spawn.steps`, adds a planning-only instruction to the task prompt, and keeps the plan flag on the launched agent where supported.
- `spawn --model <id>` threads a per-session model into the spawn request only alongside `--agent`; `resolveSpawnModel` lets an explicit request model win regardless of resolved agent, and otherwise applies the project `defaultModels` entry keyed by the resolved agent without bleeding onto another agent.
- Config parses a trigger spawn block `model` and a project `defaultModels` map keyed by agent, and rejects `.model` without `.agent`, an unknown `defaultModels` agent key, and a non-string `defaultModels` value at the parse boundary.
- Config spawn triggers accept object form and flat block arrays, preserve per-block prompt, steps, agent, and self-destruct config, and normalize scalar `spawn.agent`.
- `SessionService.selfDestruct` completes any existing session regardless of the `selfDestruct.enabled` flag and rejects an unknown session id, while `selfDestruct.enabled` now only controls whether the self-destruct prompt instructions are injected.
- Config rejects empty flat spawn arrays, plural agent fields, and `branch` with more than one normalized block.
- Config spawn triggers accept trigger-level `spawnDeskGroup: true` flat spawn arrays, reject nested `spawn.blocks` and `spawn.deskGroup`, and reject non-boolean, fewer-than-two, `autoComplete`, or mixed-workspace groups.
- Trigger runtime spawns normalized blocks sequentially with each block's prompt, steps, agent, and overrides, and logs per-block failures while continuing later non-work-item blocks.
- Trigger runtime for `spawnDeskGroup` uses the first spawn block as the desk workspace anchor, blocks later blocks when anchor spawn fails, and attaches siblings through `reuseWorkspaceSessionId` while continuing after child failures.
- Config can define project default `spawn.steps`, and request or trigger steps override them instead of merging.
- Pipeline steps wrap one task prompt, then auto-send later phases in order after the agent returns to a prompt with a 30 second delay between auto-steps.
- Busy manual `send` requests queue per session, flush after the agent returns to a prompt, and stay ahead of the next pipeline step.
- Unfinished running pipelines resume after daemon restart without restarting the session.
- Worktree creation fetches `origin`, fast-forwards a clean checked-out local default branch that is purely behind, uses `origin/<defaultBranch>` as the new worktree base when that checked-out default branch is dirty and behind, creates explicit branches from `origin/<branch>` when needed, and fails fast when freshness cannot be proven.
- Session service can also spawn in a shared workspace when `worktree=false`, rejects branch overrides that would mutate the shared repo, skips worktree cleanup on kill, rejects restore for shared workspace sessions, and rejects `defaultBranch` overrides outside worktree mode.
- Opt-in project spawn preflight runs only for worktree spawns without an explicit `branch`, can use either an explicit `preflight.prompt` or Spur's default rule-or-defer prompt, treats empty output the same as the `NO_PROJECT_RULES` sentinel, accepts one non-empty branch name, retries invalid or occupied branch suggestions with feedback, and fails before reserving a session id when all preflight attempts fail.
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
- Session metadata preserves scheduled, interval, and daily wake state when writing, reading, and listing session records.
- `GET /projects` returns daemon-owned project labels, and explicit `connect` / `disconnect` mutate only the connected project-config registry.
- `GET /projects/:id/slash-commands` and `GET /sessions/:id/slash-commands` return normalized command / skill / agent suggestions from daemon-owned filesystem discovery without changing the hot `/sessions` list payload.
- `GET /sessions/:id/artifacts/:artifactId` streams session-owned artifact bytes with inline disposition for images/videos and attachment disposition for download-only files.
- `pause` stops tmux, keeps the worktree, persists `stopped`, and leaves slot metadata intact.
- `restore(sessionId)` keeps worktree-backed sessions restorable after both manual `pause` and unexpected agent stops; a manually paused `stopped` session relaunches/resumes in place without sending any prompt, while `stopped` sessions from unexpected interruption still deliver the restore prompt.
- Boot reconcile reports drifted stopped sessions in `driftedSessions` while excluding errored ones, and `restoreRebootedSessions` only restores sessions whose project has `restoreAfterReboot` true, restarts just their autoStart sidecars, and isolates per-session restore failures.
- `complete` stops tmux, removes owned artifacts, persists `completed`, and keeps the record available for later filtering.
- `kill` and `complete` still close an existing worktree-backed session after its project id is renamed in config, as long as the worktree still resolves back to the same repo, and `complete` also tears down any sidecar tmux/process cleanup owned by that session.
- Session slot updates keep one merge path: hidden CLI/API updates `title` plus named links, preserve session timestamps, expose the helper command inside the session env, and keep hidden commands out of `spur --help`.
- `list` and `ls` surface persisted slot associations as compact PR / tracker ids instead of full URLs, and TTY selected-session details show the same compact ids.
- Session view derives optional `workspaceAccess.items[]` from project config and live workspace state, rendering `${worktreePath}`, `${worktreePathShell}`, and `${worktreePathUrl}` placeholders per session and omitting invalid rendered links.
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
- Dashboard list view stays lean while exposing only `runningSidecarNames` for sidecars whose tmux sessions are alive, without full sidecar records.
- Codex submit ack polls session rollout jsonl files for the exact trimmed user message text, with a 60s timeout and one Enter key retry.
- Cursor submit ack polls the latest agent transcript jsonl for a user turn whose text contains the sent message (cursor wraps it in context tags), captures a byte-offset baseline so prior turns are ignored, follows transcript rotation, and resends Enter in short windows to flush a message stuck in the input.
- Claude restore recovers when submit ack times out but the agent process is live, and fails with cleanup when the process is gone.
- Codex restore falls back to a fresh launch when no native resume state (thread id) is found, keeps the same worktree/session id, and still delivers the restore prompt.
- Claude restore falls back to a fresh launch when no native resume state (session id) is found, keeps the same worktree/session id, and still delivers the restore prompt.
- Session state classification collapses public session status to `working`, `waiting`, `needs_input`, `rate_limited`, `stopped`, `error`, and `killed`, using Claude session status JSON before Claude JSONL fallback, hook-primary classification plus structured rollout JSONL fallback for Codex, and pane/activity classification for Cursor.
- Rate-limit detection (`rate-limit-detect.ts`) reads structured agent sources first and overrides a running session's state to `rate_limited`: Codex via the latest rollout `token_count.rate_limits` (`rate_limit_reached_type`, numeric `credits.balance <= 0`, or a window at 100% used), Claude via a trailing synthetic `error: "rate_limit"` transcript record, Cursor via usage-limit marker text; when the structured source carries no usable data it falls back to scanning the tmux pane buffer for rendered markers, never starting from tmux.
- Claude session status reader: `readClaudeSessionStatus` reads `~/.claude/sessions/*.json`, matches the current Spur Claude session by cwd/worktree path or native `sessionId`, chooses the latest `updated`/`statusUpdated` match, maps `busy`→`working`, `idle`→`waiting`, `waiting` with `waitingFor:"permission prompt"`→`needs_input`, `waiting` without `waitingFor`→`waiting`, and returns null for unknown statuses or unknown `waitingFor` values so Claude JSONL can classify.
- Claude JSONL classifier: `classifyClaudeJsonlState` maps assistant+stop_reason→waiting, assistant+`AskUserQuestion` or `input.questions[]` metadata→immediate `needs_input`, user `tool_result` carrying a `tool_reference` to `AskUserQuestion`→immediate `needs_input`, assistant+other tool_use within the stale window→working, assistant+other tool_use past the stale window→needs_input, system/stop_hook_summary/file-history-snapshot→waiting, other user records→working, progress→working, empty→working. The stale window is `TOOL_USE_STALE_MS` (3s) by default, extended by `input.timeout` when the tool declares one, and the window is bypassed entirely when the tool sets `input.run_in_background: true`. The optional `fileMtimeMs` argument is treated as last-observed activity and keeps the classifier on `working` while the JSONL is still being written.
- Claude JSONL reader: `readClaudeJsonlState` reads incrementally from the session JSONL file, skips re-read when mtime unchanged, and returns null when no JSONL file exists.
- Codex hook-based state: hook state is used only for live state classification (not for submit ack); explicit hook `state` values or structured question metadata may set `needs_input`, no hook state defaults to `waiting`, and rollout JSONL can override stale hook snapshots with terminal waiting markers (`task_complete`, interrupted `turn_aborted`)→`waiting` or structured question markers (`input_required`, `request_user_input`)→`needs_input`, but missing or dead terminals persist `status: stopped` before any waiting fallback is exposed.
- Claude sessions skip hook state scripts (`spur-agent-state-updater.mjs`, `spur-agent-state`) and hook settings during spawn and recovery.
- State history records transitions per session in a ring buffer exposed via `SessionView.stateHistory`.
- Agent history fixture integrity: all Claude JSONL and Codex hook state fixtures match their SHA-256 manifest entries.
- Claude JSONL fixture classification covers waiting reasons from real history (end_turn, stop_sequence, system, stop_hook_summary, file-history-snapshot), all working sources (progress, user message, user tool_result, assistant streaming, fresh generic tool_use), needs_input (stale generic tool_use), declared-timeout Bash on real tails (spur-052a 900s budget, spur-0190 60s budget) both inside and past the budget, `run_in_background: true` Bash staying working regardless of age, real `AskUserQuestion` tails (spur-6e9a and spur-36e9) mapping directly to `needs_input`, and the `fileMtimeMs` anchor keeping `working` when the JSONL is still being touched past the declared budget.
- Codex hook state fixture classification covers real captured hook events: Stop→waiting, PreToolUse and PostToolUse→working, explicit `needs_input` hook payload support, structured question metadata mapping to `needs_input`, stale-hook recovery from real terminal waiting tails (`task_complete`, interrupted `turn_aborted`), and `readAgentHookState` parsing from disk.
- TTY `list` surfaces `needs_input` prominently with a top alert and `!` row indicator.
- Session ordering keeps actionable sessions above quiet or terminal ones.
- GitHub send triggers deliver immediately when the target session is waiting.
- GitLab send triggers deliver immediately when the target session is waiting.
- Busy GitHub updates queue, dedupe, drop entries that vanished from the latest source snapshot, and flush once the session returns to `waiting`.
- Manual queued sends flush one message at a time and enforce a minimum 15 second gap before the next queued delivery after `awaitingPrompt=true`.
- Manual send requests with `queue=false` bypass the queued stack and can still interrupt immediately when `interrupt=true`.
- `send.interrupt: true` interrupts immediately while working but does not repeatedly interrupt the same busy interval.
- `github:ci_failed` send triggers retry every 10 minutes while the failure signal persists, stop after 3 deliveries, wait for `waiting` when `send.interrupt=false`, and send immediately when `send.interrupt=true`.
- GitHub send triggers include built-in generic workflow hints plus event-specific next actions for review changes, CI failures, merge conflicts, and comments.
- GitHub send triggers can use `send.prompt` to replace the built-in workflow hints for that trigger.
- Trigger runtime write-through persists each queued send-trigger update to `dataDir/pending-send-batches.json`, restores persisted batches into the in-memory queue on the next `startConfiguredTriggers` startup so an intervening daemon restart no longer drops them, skips and deletes a persisted record whose trigger no longer exists or whose payload no longer parses, and logs a shutdown diagnostic for any update still queued when the runtime stops.
- `cron` sources suppress ticks that arrive before the schedule's own cadence elapses, including `runOnStart` followed by a near-boundary scheduled tick.
- PR auto-detect piggybacks on the attention monitor to discover PRs by branch name via `gh pr list --head <branch>`, sets the `pr` slot automatically, skips sessions that already have a `pr` slot or no worktree, throttles `gh` calls to 30s, backs off after 5 checks in `waiting` with no state change, resets backoff on state change, and silently handles `gh` failures.
- PR auto-detect also supports GitLab merge requests through the provider resolver, while preserving the same throttle and backoff behavior.
- PR auto-detect piggybacks on the attention monitor to discover a session PR from the live worktree branch first (falling back to persisted `session.branch`), persists the native GitHub PR binding when one exists, projects the `pr` link for display, skips sessions that already have a PR binding or no worktree, throttles checks to 30s, backs off after 5 checks in `waiting` with no state change, resets backoff on state change, and silently handles CLI failures.
- When GitHub has no matching PR, PR auto-detect falls back through the ordered review providers and can still set the `pr` slot from a GitLab merge request URL without changing the throttle/backoff behavior.
- `isGitHubEventData` and `isServiceProblemEventData` type guards accept valid shapes and reject null, missing fields, and wrong field types.
- `createSendBatchParser` dispatches `github` and `service` types to their batch parsers and returns a no-op for unknown types.
- GitHub send batch `merge` deduplicates signals by key and updates PR metadata; `prune` removes signals absent from the latest source snapshot; `format` includes PR number, title, signal texts, and kind-specific action lines (or a custom prompt override).
- GitHub source polling emits the PR lifecycle events `github:ready_for_review` (only when a draft PR turns ready), `github:approved` (once per distinct reviewer), and exactly one of `github:merged` or `github:closed` for a terminal PR state, and each lifecycle event fires once per snapshot key so a second identical poll re-emits nothing.
- GitHub send batch `format` renders kind-specific action lines for every PR lifecycle signal: ready-for-review, approving review, merged, and closed-without-merging.
- Service send batch `merge` accumulates rule ids; `format` includes service id, sorted rule ids, and a custom prompt override.
- `shortText` collapses whitespace and truncates with ellipsis at a configurable limit.
- `parseRepoFromUrl` extracts `owner/repo` from GitHub PR URLs and returns empty for non-PR or invalid URLs.
- `normalizeReviewDecision` maps GitHub review decision strings to the internal enum and defaults to `none` for null, undefined, empty, or unknown values.
- `summarizeFailingCi` lists names of checks in any failing state and returns null when all pass.
- `hasMergeConflict` detects `CONFLICTING` mergeable or `DIRTY` merge state status.
- `normalizeLines` splits on newlines, trims trailing whitespace, and removes blank lines.
- `appendedLines` detects the overlap between previous and next line arrays and returns only the newly appended lines.
- `formatSessionLinkDisplay` extracts compact review ids from GitHub and GitLab URLs, Jira keys from tracker URLs, and falls back to the last path segment or label for unknown URL shapes.
- `appendEventLog` creates the data directory, writes JSONL entries, and auto-fills timestamps; `readEventLog` skips malformed lines; `readSessionEventLog` filters by session and respects a limit parameter.
- `extractCommandBinary` skips leading env-var assignments, handles single- and double-quoted binaries, and falls back when the command is empty.
- `parseAgentName` accepts `claude` and `codex` and throws for unsupported agent names.
- Codex preflight and runtime launch inject a `trust_level = "trusted"` entry for the relevant project path so fresh worktrees never hit the interactive "Do you trust..." prompt.
- `shellEscape` wraps values in single quotes and escapes embedded quotes with the standard `'\''` pattern.
- `sidecarCallerContextFromEnv`, `sidecarCallerContextFromRequest`, `nextSidecarDepth`, and `startSidecarRequestFromEnv` resolve caller name and depth from env or request, fall back to `ROOT_SIDECAR_DEPTH` on missing or invalid depth, and `formatNestedSidecarStartError` produces a one-level-deep refusal message.
- `formatPipelineStepMessage` emits the `[Spur step k/n: <label>]` header, the "Do only this step" footer before the final step, and the "This is the final step" footer on the last step.
- `parseSpawnOverrides` returns undefined for undefined input, rejects unknown keys, rejects non-boolean `worktree` and non-string or blank `defaultBranch`, and round-trips a valid pair.
- `cursorShowsReadyPrompt` and `cursorShowsWorkspaceTrustPrompt` resolve marker order by last-match index so a later ready marker hides an earlier needs-input or trust marker and vice versa.
- `EventBus` delivers events to active subscribers, stops delivery after unsubscribe, isolates throwing listeners from siblings, and logs listener failures through `writeStderr`.
- GitLab review provider resolves merge-request summaries from `glab` JSON, derives the project path from the MR URL, flags conflict on mergeable CONFLICTING, and emits `merge_conflict` plus `ci_failed` signals from failing pipelines.
- Work-item backlog emitter records every unseen candidate, suppresses a repo's first-poll backlog unless `emitExisting` is true, then caps first-poll emissions at `WORK_ITEM_FIRST_POLL_EMIT_CAP` per repo independently.

## Runtime Integration

- `doctor` writes a local config at the repo root in a fresh repo, even when launched from a nested directory, then the next `list --json` auto-connects that repo through the normal registry flow.
- `list --json` auto-starts the daemon, auto-inits the global instance config when missing, auto-connects the nearest local project config when present, and returns `[]` on a fresh registry; `ls --json` does the same.
- `spawn` auto-inits the global instance config when missing and auto-connects the nearest local project config before project validation.
- `send`, `pause`, `complete`, `kill`, `service`, and hidden `daemon` commands use the global instance config but do not auto-connect a local project config.
- `spawn --json` creates a normal Spur session through the built CLI, with a real `git worktree`, configured symlinks, detached `tmux`, and fake agent launch.
- `spawn --json --agent codex` writes the spawned worktree path into the session-local `CODEX_HOME/config.toml` as `trusted`, so worktree launches stay non-interactive.
- `spawn --json` keeps one task prompt, and configured pipeline steps deliver ordered phases in the same session with a 30 second delay between auto-steps.
- `spawn --json` without `[prompt...]` creates a blank session, does not deliver an initial message, and does not apply default pipeline steps.
- `spawn --json --plan` ignores manual and configured spawn steps and sends only the planning prompt derived from the task to the agent.
- `spawn --json` fetches `origin` before worktree creation, so a remote-advanced clean `main` lands in both the new Spur worktree and the local base branch.
- `spawn --json` with a dirty checked-out `main` still uses the fresh `origin/main` commit as the new worktree base and does not mutate local `main`.
- `spawn --json --worktree <defaultBranch>` creates a new worktree branch from the requested `defaultBranch` override through the built CLI.
- `spawn --json` can use an opt-in project spawn preflight through built `claude`, `codex`, and `cursor` preflight paths, and the returned branch becomes the live worktree branch.
- `spawn --json` retries when a preflight-suggested branch is already checked out in another worktree, and `spawn --json --branch <name>` rejects that same conflict with the conflicting worktree path.
- Interactive spawn with preflight-enabled project calls `/projects/:id/preflight`, shows branch confirmation, and passes the confirmed branch in the spawn request.
- Non-TTY and `--json` spawn skip the preflight endpoint call.
- `POST /sessions/background` returns the placeholder session immediately, closes the web spawn modal on ack, and leaves the modal open when the daemon/API ack fails.
- `spawn --json` can also start a shared workspace session through the built CLI, keep the project path intact on kill, and reject `--shared --branch <name>` for a shared repo.
- `send --json` reaches the same `tmux`-backed session and the pane keeps both the initial prompt and the follow-up message.
- `send --json` queues while the fake agent is busy and delivers the queued message before the next pipeline step.
- `pause --json` stops runtime, keeps the worktree, keeps the session visible in `list --json`, and a later `send --json` can resume it in place.
- `wake --every --json` and `wake --daily-at --until --json` persist recurring wake state through CLI response, `list --json`, `GET /sessions/:id`, and disk without waiting for timer delivery.
- `complete --json` stops runtime, removes the owned worktree, persists `completed`, and disappears from `list --json`.
- `respawn --json` rejects running sessions, respawns a terminal session into a new running session, and keeps lifecycle cleanup available through normal `kill --json`.
- `POST /sessions/:id/respawn` accepts an edited initial prompt plus startup image selections and new image attachments, then launches the replacement session from that merged startup input.
- `respawn --json` preserves shared-workspace mode for shared sessions, preserves explicit branch targets, and falls back to a fresh session id branch when respawn preflight defers or picks an occupied worktree branch.
- `complete --json` and `kill --json` still work for sessions spawned under an old project id after the config renames that project to the same repo path, including sidecar cleanup on `complete --json`.
- `send --json` to a stopped or paused worktree-backed session resumes the same native Claude/Codex conversation when native state exists, otherwise relaunches in the same worktree and still delivers the message; automatic queue/pipeline delivery does not restart a persisted stopped session on its own.
- The per-session `spur-slots` helper updates a live session title and named links through the hidden CLI/API path without restarting the session, leaves the `tmux` status bar disabled (the title shows in the Spur UI, not `tmux`), and preserves stored link metadata.
- `service run` started from a session workspace creates a sidecar `tmux` session, `service status` inspects that live sidecar through the built CLI, and TTY `list` `l` opens a session log view with structured events while agent/runtime log output stays empty until a non-`tmux` log source exists.
- The per-session `spur-self-destruct` helper completes its own enabled session through the hidden self-destruct CLI/API path without requiring arguments.
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
- Codex restore prompt uses one-shot tmux submit without rollout-ack wait or retry, while normal Codex sends keep strict rollout ack and retry behavior.
- Daemon desktop notifications establish a startup baseline, notify once when a live session enters `needs_input` or `error`, and stay quiet until that attention state clears.
- `spawn` rejects an unknown project through the built CLI without creating session side effects.
- `send`, `wake`, `pause`, `complete`, and `kill` reject an unknown session id through the built CLI.
- `send` rejects a `completed` or `killed` session through the built CLI.
- `POST /sessions/:id/kill` rejects a session whose worktree has uncommitted changes or unpushed commits unless `force: true`.
- `slots` rejects an unknown session id and malformed `--link label=url` input through the built CLI.
- Hidden `daemon stop --json` stops a running daemon and stays a no-op when it is already down or `/info` is incompatible without a Spur runtime pid.
- Hidden `daemon restart --json` replaces a live daemon and stays a no-op when it is already down or `/info` is incompatible without a Spur runtime pid.
- Hidden `daemon restart --json` fails fast instead of forking a rogue replacement daemon when `SPUR_DISABLE_AUTOSTART=1` protects a managed restart window.
- Restarting the daemon from a different compatible config path reloads every registered config from `dataDir`, so previously attached projects remain available after boot.
- After an abrupt host reboot (tmux server killed), a fresh daemon restores a `restoreAfterReboot: true` session back to running with its agent and autoStart sidecar tmux re-created, while a default (`restoreAfterReboot: false`) session stays stopped with no agent tmux recreated.
- Multiple daemon instances stay isolated by tmux socket name, so runtime sessions and web terminal attach target the selected Spur instance instead of the global default tmux server.
- `pnpm build` restarts a running daemon when `SPUR_CONFIG` or a nearby Spur config is available, and stays a no-op when no daemon is running or `/info` is incompatible without a Spur runtime pid.
- `ls` rejects unknown options through the built CLI.
- `cron` `runOnStart: true` emits on daemon boot and reaches the normal spawn flow without manual CLI input.
- `cron` `runOnStart: true` can also reach `trigger.spawn.prompt` plus optional `trigger.spawn.steps` and deliver the same ordered pipeline behavior as manual spawn.
- `cron` `runOnStart: true` can also reach the shared workspace path through `trigger.spawn.overrides.worktree: false`.
- GitHub source polling emits `github:comment` only when the stored snapshot changes for a running session with a bound PR.
- GitHub source polling plus send triggers deliver `github:ci_failed` into the live tmux-backed session when failing checks appear on the bound PR, even if the worktree branch later drifts.
- GitHub source polling emits `github:merge_conflict` only when the tracked PR becomes conflicting, clears it when the conflict disappears, and emits again if the conflict returns later.
- GitHub source polling plus send triggers deliver `github:merge_conflict` into the live tmux-backed session when merge conflicts appear on the tracked PR.
- After a stopped session is restored back to `running`, GitHub source polling re-delivers any still-active `github:merge_conflict` signal to the restored tmux-backed session without requiring the PR state to change again.
- Service sources currently do not emit `service:<ruleId>` until Spur has a non-`tmux` service log source.

- Claude agent status detection: spawn produces `waiting` (end_turn JSONL), `send` produces `working` (user JSONL), `show-waiting-menu` produces `needs_input` from `AskUserQuestion` JSONL metadata, and normal message exchange cycles waiting→working→waiting.
- Codex agent status detection: spawn produces `waiting` (Stop hook), `send` produces `working` (UserPromptSubmit hook), `show-waiting-menu` produces `needs_input` from structured hook/rollout state, stale `PreToolUse` snapshots are cleared by `task_complete`, and normal message exchange cycles waiting→working→waiting.
- Session-level lifecycle for both Claude and Codex: `pause` persists `paused` with public state `stopped`, `complete` persists `completed` with public state `stopped`, `kill` persists `killed`, and unexpected agent/runtime exit persists `stopped`.
- State history records transitions during a Claude session lifecycle.
- Session state transitions append `session.state.transition` events once per real change, include `fromState`, `toState`, and detection `source`, and snapshot the latest agent history JSONL into session artifacts when available.
- Sidecar auto-starts only on session spawn when `autoStart: true`; nested sidecars remain manual-only.
- Multiple sidecars per session get separate tmux panes.
- Sidecar cleanup on kill/complete/pause and failed spawn rollback.
- Manual sidecar start/stop via `spur sidecar start|stop --session <id> --name <name>`, and `start` also allows one nested hop through the injected `spur-sidecar` helper.
- Sidecar status reported in session view.

## Real-Agent Smoke

- `claude` launches as a real agent in a Spur worktree created from this repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- `codex` launches as a real agent in a Spur worktree created from this repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- `cursor` launches as a real agent in a Spur worktree created from this repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- Real `claude`, `codex`, and `cursor` can also satisfy an opt-in spawn preflight before the normal worktree session launch, and Spur uses the returned branch.
- Real `claude`, `codex`, and `cursor` sessions can set `title` and named `links` through injected `spur-slots` instructions; those slots survive `restore` in session metadata, and the title shows in the Spur UI while the `tmux` status bar stays disabled.

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
- `sidecars` config resolves `${VAR}` placeholders in `env` values and optional port `url`, omits unresolved values, and rejects invalid published URLs
- `sidecars` config also resolves bare env names like `SPUR_SIDECAR_PUBLIC_URL` from the project's `.env` file or process env, and omits unresolved optional values instead of leaking placeholder strings
- `devServer` backward compat: parsed as `sidecars.dev` with same command/autoStart
- Both `devServer` and `sidecars` defined: throws error
- Invalid sidecar reserved port ranges fail config validation
- Optional `workspaceAccess.items[].value` resolves `${VAR}` placeholders and bare env names from project `.env` / process env, and drops unresolved items instead of emitting broken UI actions
- Sidecar tmux session naming: `{sessionId}--{sidecarName}`
- `buildSessionEnv` includes `SPUR_SESSION_TOOL_DIR`, excludes `SPUR_CONFIG`
- Sidecar env merges session env with sidecar config env and sets `SPUR_SIDECAR_DEPTH`
- `ensureSessionSlotTool` creates `spur-sidecar` wrapper script
- Sidecar reserved-port allocation skips TCP ports already bound outside Spur while preserving existing session metadata reservations
- `sidecar start --clear-port <port>` clears a daemon-validated occupied sidecar port before retrying launch

**Tier: runtime integration**

- Sidecar auto-starts only on session spawn when `autoStart: true`
- Multiple sidecars per session get separate tmux panes
- Reserved sidecar ports are assigned when a sidecar starts, injected into sidecar env, and released after cleanup
- Reserved sidecar ports skip OS-bound TCP ports, still fail fast when metadata plus bound ports exhaust the range, and succeed after the external bind and Spur reservation are both released
- Spawn continues when sidecar autostart cannot reserve a port; manual `sidecar start` fails fast until a port is released, then succeeds
- `isolated-daemon` writes isolated runtime artifacts and registry so sibling sidecars can target the isolated Spur daemon
- After autostart or manual `sidecar start`, core probes `127.0.0.1:<reservedPort>/` and on the first HTTP response publishes a session slot link `{label: <sidecarName>, url: "<resolved port url>:<reservedPort>"}`; `complete` and `kill` abort the probe and unlink the slot
- Sidecar cleanup on kill/complete/pause and failed spawn rollback
- Manual sidecar start/stop via `spur sidecar start|stop --session <id> --name <name>`
- Nested sidecars are manual-only through `spur-sidecar`, nesting stops after one extra level, and rejected depth overruns are logged
- Sidecar status reported in session view

### GitHub work-item triggers

**Tier: fast**

- `config.github.query` — `query` parses and is preserved on the github source.
- `config.github.work_item_event_only_when_query_set` — rejects `github:work_item.new` triggers when `query` is unset.
- `config.github.work_item_unique_per_source` — rejects two triggers on the same github source both subscribed to `github:work_item.new`.
- `config.github.work_item_auto_complete_scope` — accepts `spawn.autoComplete` on `github:work_item.new` and rejects it on send or non-work-item spawn triggers.
- `triggers.spawn.work_item_seeds_pr_link` — spawn payload carries `slots.links` with the `pr` label, renders work-item prompt placeholders, and records lifecycle state when `autoComplete` is true.
- `triggers.spawn.work_item_auto_complete` — lifecycle checks complete only waiting sessions after the minimum age and leave `needs_input` or active sessions open.
- `metadata.work_item_registry` — `recordWorkItem` round-trips through `readWorkItemRegistry`; missing or corrupt files return an empty set.
- `metadata.work_item_lifecycle_registry` — work-item lifecycle bindings round-trip and delete cleanly.
- `github.work_item.query_open_state_flag` — poller builds `gh search prs <query> --state open` with no `is:` qualifiers in the query string (the `is:` form returns empty results).
- `github.work_item.first_poll_backlog_suppressed` — first poll for a repo absent from the registry records every returned PR as seen and emits zero `github:work_item.new`; once the repo has a seen entry, only genuinely new PRs emit.
- `config.github.emit_existing` — `emitExisting` parses and is preserved on the github source (default false).
- `github.work_item.first_poll_emit_existing` — with `emitExisting: true`, the first-poll backlog emits up to a cap of 10 `github:work_item.new` and records every returned PR as seen.
- `config.sentry.source` — sentry source parses with a resolved `${VAR}` token and applies `baseUrl`/`query`/`intervalMs`/`emitExisting` defaults; rejects an unresolved `authToken`.
- `config.sentry.work_item_event_scope` — accepts a `sentry:issue.new` trigger with `spawn.autoComplete` and rejects unknown events for a sentry source.
- `sentry.issue.poll` — sentry poller emits `sentry:issue.new` for unseen issues, suppresses seen ones, suppresses the first-poll backlog unless `emitExisting: true` (capped at 10), and records every issue as seen.
- `triggers.spawn.sentry_issue_lifecycle` — a `sentry:issue.new` event runs the shared work-item spawn path: seeds the slot link, renders the prompt, and records lifecycle state when `autoComplete` is true.
- `config.github.code_review_self_destruct_wake` — root CodeReview trigger spawns `/code-review <url>` with self-destruct enabled and schedules a recurring 12h wake to recheck PR state until self-destruct conditions pass.

**Tier: runtime integration**

- `github.work_item.poll_emits_once_per_external_id` — two-PR fixture, single emit per `externalId`, idempotent across daemon restart and across repeated polls on the same fixture.
- `github.work_item.coexists_with_signal_branch` — when `query` is also set, the per-branch signal branch still fires `github:ci_failed` for an attached session alongside `github:work_item.new` from the query branch.

## Regression Rule

- When a new Spur feature or failure mode is added, extend this file in the same change.
- For `v2/`-only changes, rerun the impacted tier scenarios and the touched CLI commands through positive and negative paths.
- For touched `v2/` code, also check hanging logic, stray fallbacks outside boundary and cleanup paths, and loose or bloated type shapes.
