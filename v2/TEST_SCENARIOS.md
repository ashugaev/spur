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
- Client reuses a compatible daemon, auto-starts when unreachable, replaces an incompatible daemon, and surfaces JSON error payloads.
- Registry merges compatible config files into one daemon project set, materializes each project's effective default agent once, and rejects duplicate project ids or `sessionPrefix` values across registered configs.
- Config applies defaults once at the parse boundary for `server`, `defaultAgent`, project `worktree`, trigger spawn overrides, `runOnStart`, `intervalMs`, and `send.interrupt`.
- Config applies service-source defaults once at the parse boundary for `intervalMs`, `tailLines`, and `rules.*.cooldownMs`, and validates `service:<ruleId>` trigger events against declared rule ids.
- Config rejects removed GitHub event names so the live GitHub surface stays `github:changes_requested`, `github:ci_failed`, `github:comment`, and `github:merge_conflict`.
- Config rejects duplicate `sessionPrefix` values across projects.
- Session service spawn follows one path: optional worktree spawn preflight, reserve id, resolve branch, create worktree, create `tmux`, wait for agent readiness, send the initial prompt, then persist the running record.
- `spawn` requires one positional `<prompt...>` task.
- `spawn --step <label>` repeats to override any configured project default `spawn.steps` for one manual session.
- Config spawn triggers require `spawn.prompt` and may add optional `spawn.steps`.
- Config can define project default `spawn.steps`, and request or trigger steps override them instead of merging.
- Pipeline steps wrap one task prompt, then auto-send later phases in order after the agent returns to a prompt with a 30 second delay between auto-steps.
- Unfinished running pipelines resume after daemon restart without restarting the session.
- Worktree creation fetches `origin`, fast-forwards a purely behind local branch, creates explicit branches from `origin/<branch>` when needed, and fails fast when freshness cannot be proven.
- Session service can also spawn in a shared workspace when `worktree=false`, rejects branch overrides that would mutate the shared repo, skips worktree cleanup on kill, rejects restore for shared workspace sessions, and rejects `defaultBranch` overrides outside worktree mode.
- Opt-in project spawn preflight runs only for worktree spawns without an explicit `branch`, can use either an explicit `preflight.prompt` or Spur's default rule-or-defer prompt, accepts either one branch name or the `NO_PROJECT_RULES` sentinel, and fails before reserving a session id when preflight output is invalid.
- Spawn creates compact session ids in the form `<prefix>-<hash4>` and retries on collisions before failing.
- Session lifecycle and trigger handling append structured key events to `dataDir/events.jsonl` for spawn, send, slot updates, kill, restore, and trigger match/deliver/drop paths.
- Spawn captures Claude/Codex native session ids when the agent writes them to disk.
- Paused and crashed worktree-backed sessions can resume on later `send` by reusing stored native resume state when available, re-discovering it from agent state on disk when missing, and falling back to a fresh launch when native resume is stale.
- `list`, `send`, `pause`, `complete`, and `kill` target the exact tmux session name, so `spur-a1b2` never resolves to another same-prefix session.
- `list` hides `completed` and `killed` sessions by default while keeping `paused` sessions visible.
- `pause` stops tmux, keeps the worktree, persists `paused`, and leaves slot metadata intact.
- `complete` stops tmux, removes owned artifacts, persists `completed`, and keeps the record available for later filtering.
- Session slot updates keep one merge path: hidden CLI/API updates `title` plus named links, preserve session timestamps, expose the helper command inside the session env, and keep hidden commands out of `spur --help`.
- Session setup injects both `spur-slots` and a session-bound `spur` wrapper into the helper tool dir, so in-session commands can call `spur service run ...` against the right config.
- `service run --port <n>` persists the port once, and `list` surfaces it in session details and one-shot summaries.
- Service triggers batch by session, dedupe matched rule ids, and deliver only a problem notice plus `spur service logs` / `spur service attach` inspection commands.
- Spawn failure after placeholder metadata cleans up `tmux` and worktree side effects and persists an errored record.
- Repeated kill on an already cleaned session stays idempotent and does not rewrite terminal metadata.
- Repeating the same manual status (`pause` or `complete`) stays idempotent and does not rewrite metadata.
- Session state classification collapses public session status to `working`, `waiting`, `needs_input`, `stopped`, `error`, and `killed`, using fresh native Claude/Codex activity signals before the plan-mode menu, permission prompt, and trailing-UI tmux fallbacks.
- TTY `list` surfaces `needs_input` prominently with a top alert and `!` row indicator.
- Session ordering keeps actionable sessions above quiet or terminal ones.
- GitHub send triggers deliver immediately when the target session is waiting.
- Busy GitHub updates queue, dedupe, drop entries that vanished from the latest source snapshot, and flush once the session returns to `waiting`.
- `send.interrupt: true` interrupts immediately while working but does not repeatedly interrupt the same busy interval.
- `github:ci_failed` send triggers retry every 10 minutes while the failure signal persists, stop after 3 deliveries, wait for `waiting` when `send.interrupt=false`, and send immediately when `send.interrupt=true`.
- GitHub send triggers include built-in generic workflow hints plus event-specific next actions for review changes, CI failures, merge conflicts, and comments.
- GitHub send triggers can use `send.prompt` to replace the built-in workflow hints for that trigger.
- `cron` sources suppress ticks that arrive before the schedule's own cadence elapses, including `runOnStart` followed by a near-boundary scheduled tick.

## Runtime Integration

- `list --json` auto-starts the daemon and returns `[]` on a fresh config, and `ls --json` does the same.
- Normal CLI session commands sync their current config into the running daemon registry before they hit `/sessions`.
- `spawn --json` creates a normal Spur session through the built CLI, with a real `git worktree`, configured symlinks, detached `tmux`, and fake agent launch.
- `spawn --json` keeps one task prompt, and configured pipeline steps deliver ordered phases in the same session with a 30 second delay between auto-steps.
- `spawn --json` fetches `origin` before worktree creation, so a remote-advanced `main` lands in both the new Spur worktree and the local base branch.
- `spawn --json --worktree <defaultBranch>` creates a new worktree branch from the requested `defaultBranch` override through the built CLI.
- `spawn --json` can use an opt-in project spawn preflight through built `claude` and `codex` one-shot paths, and the returned branch becomes the live worktree branch.
- `spawn --json` can also start a shared workspace session through the built CLI, keep the project path intact on kill, and reject `--shared --branch <name>` for a shared repo.
- `send --json` reaches the same `tmux`-backed session and the pane keeps both the initial prompt and the follow-up message.
- `pause --json` stops runtime, keeps the worktree, keeps the session visible in `list --json`, and a later `send --json` can resume it in place.
- `complete --json` stops runtime, removes the owned worktree, persists `completed`, and disappears from `list --json`.
- `send --json` to a stopped or paused worktree-backed session resumes the same native Claude/Codex conversation when native state exists, otherwise relaunches in the same worktree and still delivers the message.
- The per-session `spur-slots` helper updates a live session title and named links through the hidden CLI/API path and refreshes `tmux` status hyperlinks without restarting the session.
- `service run` started from a session workspace creates a sidecar `tmux` session, and `service status`, `service logs`, and `service attach` inspect that live sidecar through the built CLI.
- Daemon startup, CLI session lifecycle, and automation source/trigger flows append structured key events to `dataDir/events.jsonl`.
- TTY `list` attaches in place on `Enter`, enables tmux mouse mode for scrollback, shows the `Ctrl+G detach` hint, and returns to the selector after detach.
- TTY `list` can attach to the selected session's first live service sidecar with `s`, and `Ctrl+G` detaches back to the selector.
- TTY `list` can pause, complete, and kill the selected live session in place; `completed` or `killed` sessions disappear from the live list without silently retargeting another row, and a killed session is not restorable on `Enter` or `r`, with terminal metadata showing `runtimeAlive: false` and `workspaceExists: false`.
- TTY `list` asks for confirmation before killing a session whose worktree has uncommitted changes or unpushed commits, and a second `k` forces the kill.
- TTY `list` can restore a stopped session in place, keep the same session id and worktree, use the agent CLI's native resume path when session state exists, and deliver the restore prompt through `tmux`.
- TTY `list` surfaces a restore error in place and keeps the session stopped when the agent's native resume state is missing.
- `spawn` rejects an unknown project through the built CLI without creating session side effects.
- `send`, `pause`, `complete`, and `kill` reject an unknown session id through the built CLI.
- `send` rejects a `completed` or `killed` session through the built CLI.
- `POST /sessions/:id/kill` rejects a session whose worktree has uncommitted changes or unpushed commits unless `force: true`.
- `slots` rejects an unknown session id and malformed `--link label=url` input through the built CLI.
- Hidden `daemon stop --json` stops a running daemon and stays a no-op when it is already down or `/info` is incompatible without a Spur runtime pid.
- Hidden `daemon restart --json` replaces a live daemon and stays a no-op when it is already down or `/info` is incompatible without a Spur runtime pid.
- Restarting the daemon from a different compatible config path reloads every registered config from `dataDir`, so previously attached projects remain available after boot.
- `pnpm build` restarts a running daemon when `SPUR_CONFIG` or a nearby Spur config is available, and stays a no-op when no daemon is running or `/info` is incompatible without a Spur runtime pid.
- `ls` rejects unknown options through the built CLI.
- `cron` `runOnStart: true` emits on daemon boot and reaches the normal spawn flow without manual CLI input.
- `cron` `runOnStart: true` can also reach `trigger.spawn.prompt` plus optional `trigger.spawn.steps` and deliver the same ordered pipeline behavior as manual spawn.
- `cron` `runOnStart: true` can also reach the shared workspace path through `trigger.spawn.overrides.worktree: false`.
- GitHub source polling emits `github:comment` only when the stored snapshot changes for a running session with a matching PR branch.
- GitHub source polling plus send triggers deliver `github:ci_failed` into the live tmux-backed session when failing checks appear on the tracked PR.
- GitHub source polling emits `github:merge_conflict` only when the tracked PR becomes conflicting, clears it when the conflict disappears, and emits again if the conflict returns later.
- GitHub source polling plus send triggers deliver `github:merge_conflict` into the live tmux-backed session when merge conflicts appear on the tracked PR.
- Service source polling emits `service:<ruleId>` only for configured session-bound services, and matching send triggers notify that same live session with inspection commands instead of inlined logs.

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
- Empty message for `send`.
- `send` to a `completed` or `killed` session.
- `cron` source without `schedule`.
- Trigger spawn without `prompt`.
- Trigger referencing an unknown source.
- `service run` outside a live Spur session.
- `service status` for an unknown session id.
- `service logs` for a stopped or missing service.
- `service attach` for a stopped or missing service.

## Regression Rule

- When a new Spur feature or failure mode is added, extend this file in the same change.
- For `v2/`-only changes, rerun the impacted tier scenarios and the touched CLI commands through positive and negative paths.
- For touched `v2/` code, also check hanging logic, stray fallbacks outside boundary and cleanup paths, and loose or bloated type shapes.
