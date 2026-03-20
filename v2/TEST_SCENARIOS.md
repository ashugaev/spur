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

- Root help exposes only `spawn`, `list`, and `send`, keeps the branded help output, and hides the internal `daemon` command.
- `list` subcommand help keeps the compact sections, inherited global options, and the TTY note.
- In-process server returns runtime info and stops cleanly.
- Client reuses a compatible daemon, auto-starts when unreachable, replaces an incompatible daemon, and surfaces JSON error payloads.
- Config applies defaults once at the parse boundary for `server`, `defaultAgent`, project `worktree`, trigger spawn overrides, `runOnStart`, `intervalMs`, and `send.interrupt`.
- Config rejects removed GitHub event names so the live GitHub surface stays `github:changes_requested`, `github:ci_failed`, and `github:comment`.
- Config rejects duplicate `sessionPrefix` values across projects.
- Session service spawn follows one path: reserve id, resolve branch, create worktree, create `tmux`, wait for agent readiness, send the initial prompt, then persist the running record.
- Session service can also spawn in a shared workspace when `worktree=false`, rejects branch overrides that would mutate the shared repo, skips worktree cleanup on kill, rejects restore for shared workspace sessions, and rejects `defaultBranch` overrides outside worktree mode.
- Spawn failure after placeholder metadata cleans up `tmux` and worktree side effects and persists an errored record.
- Repeated kill on an already cleaned session stays idempotent and does not rewrite terminal metadata.
- Session state classification collapses public session status to `working`, `waiting`, `needs_input`, `stopped`, `error`, and `killed`, including plan-mode menus, permission prompts, and Codex trailing UI.
- TTY `list` surfaces `needs_input` prominently with a top alert and `!` row indicator.
- Session ordering keeps actionable sessions above quiet or terminal ones.
- GitHub send triggers deliver immediately when the target session is waiting.
- Busy GitHub updates queue, dedupe, drop entries that vanished from the latest source snapshot, and flush once the session returns to `waiting`.
- `send.interrupt: true` interrupts immediately while working but does not repeatedly interrupt the same busy interval.
- `github:ci_failed` send triggers retry every 10 minutes while the failure signal persists, stop after 3 deliveries, wait for `waiting` when `send.interrupt=false`, and send immediately when `send.interrupt=true`.

## Runtime Integration

- `list --json` auto-starts the daemon and returns `[]` on a fresh config, and `ls --json` does the same.
- `spawn --json` creates a normal Spur session through the built CLI, with a real `git worktree`, configured symlinks, detached `tmux`, and fake agent launch.
- `spawn --json --worktree <defaultBranch>` creates a new worktree branch from the requested `defaultBranch` override through the built CLI.
- `spawn --json` can also start a shared workspace session through the built CLI, keep the project path intact on kill, and reject `--shared --branch <name>` for a shared repo.
- `send --json` reaches the same `tmux`-backed session and the pane keeps both the initial prompt and the follow-up message.
- TTY `list` attaches in place on `Enter`, enables tmux mouse mode for scrollback, and returns to the selector after detach.
- TTY `list` can kill the selected live session in place and leaves terminal metadata with `runtimeAlive: false` and `workspaceExists: false`.
- TTY `list` can restore a stopped session in place, keep the same session id and worktree, use the agent CLI's native resume path when session state exists, and deliver the restore prompt through `tmux`.
- TTY `list` surfaces a restore error in place and keeps the session stopped when the agent's native resume state is missing.
- `spawn` rejects an unknown project through the built CLI without creating session side effects.
- `send` rejects an unknown session id through the built CLI.
- `ls` rejects unknown options through the built CLI.
- `cron` `runOnStart: true` emits on daemon boot and reaches the normal spawn flow without manual CLI input.
- `cron` `runOnStart: true` can also reach the shared workspace path through `trigger.spawn.overrides.worktree: false`.
- GitHub source polling emits `github:comment` only when the stored snapshot changes for a running session with a matching PR branch.
- GitHub source polling plus send triggers deliver `github:ci_failed` into the live tmux-backed session when failing checks appear on the tracked PR.

## Real-Agent Smoke

- `claude` launches as a real agent in a Spur worktree created from the real `ao` repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- `codex` launches as a real agent in a Spur worktree created from the real `ao` repo, resumes through `restore`, accepts a follow-up `send`, and the session tears down cleanly.
- A real agent can open a disposable PR from its Spur worktree, then the same live session receives `github:comment` and `github:ci_failed`, and cleanup closes the PR, clears the temporary status/comment noise, and tears the session down cleanly.
- When a reviewer-capable second GitHub identity is available for the target repo, the same disposable-PR flow also receives `github:changes_requested` in the live session.

## Regression Rule

- When a new Spur feature or failure mode is added, extend this file in the same change.
- For `v2/`-only changes, rerun the impacted tier scenarios and the touched CLI commands through positive and negative paths.
- For touched `v2/` code, also check hanging logic, stray fallbacks outside boundary and cleanup paths, and loose or bloated type shapes.
