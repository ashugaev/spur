---
name: migrate-orchestrator-v2
description: "Use when planning or implementing the lean migration to Spur in `v2/`. Covers the simplified shape: separate daemon plus CLI, prompt-first spawn, tmux plus worktree plus symlinks, claude/codex launch, flat metadata, and the minimal source->event->trigger loop."
---

# Migrate Spur

## Use this skill when

- The task is about designing, migrating, or implementing the new `v2/` orchestrator.
- The task touches `v2` daemon, HTTP API, CLI, session lifecycle, `tmux`, `git worktree`, or agent launch.
- The main question is what to port from current AO and what to leave behind.

## Fixed defaults

- `v2/` is a clean rewrite in a separate folder, not an in-place evolution of current `ao`.
- The `v2/` product name is `Spur`.
- Change only `v2/` for Spur work. Treat `v1` and the current `ao` tree as legacy reference-only and do not wire new Spur behavior to them.
- `v2` has its own CLI, YAML config, state directory, daemon runtime, and API surface.
- CLI is an HTTP client over a local daemon and auto-starts that daemon when needed.
- `spawn` is positional: `spur spawn <project> <prompt...>`, with optional `agent` and `branch`.
- Milestone 1 human session ops are: `spawn`, `list`, `send`, `pause`, `complete`, `kill`.
- `daemon start` stays as the internal daemon command and is hidden from `spur --help`.
- `list` is the only session UI.
  On a TTY it shows runtime summary, the live selector, and selected-session details; `Enter` attaches in place, `p` pauses, `c` completes, `r` restores a restorable exited session in place, `k` kills, and `Esc` quits.
  Non-TTY `list` stays a one-shot runtime summary plus session cards.
- Workspace bootstrap is only: `git worktree` plus configured `symlinks`.
- Supported agents for now: `claude` and `codex`.
- Both supported agents start with full access by default:
  `claude --dangerously-skip-permissions` and
  `codex --dangerously-bypass-approvals-and-sandbox`.
- Minimal automation is allowed only as project-local `sources -> events -> triggers -> spawn|send`.
- Current built-in sources are `cron` and `github`.
- Do not write speculative code in `v2`. If a field, branch, or helper is not used by current Spur behavior, remove it.
- No UI, dashboard, SSE, mobile, or terminal-web layer.
- No generic tracker, SCM, notifier, reaction, or step/pipeline layer.
- No PluginRegistry, LifecycleManager, or current SessionManager carry-over.
- No compatibility bridge to the current `agent-orchestrator.yaml`.
- No `postCreate` hooks in milestone 1.

## Target shape

Keep `v2` small and explicit. Prefer a direct module graph over plugin slots.

Recommended first layout:

```text
v2/
  src/
    config.ts
    metadata.ts
    ids.ts
    workspace.ts
    runtime-tmux.ts
    agents/
      claude.ts
      codex.ts
    event-bus.ts
    event-sources/
      cron.ts
      index.ts
      types.ts
    triggers.ts
    session-service.ts
    server.ts
    client.ts
    cli.ts
  spur.yaml.example
```

Recommended minimal config shape:

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
    symlinks: [.env, .claude]
    sources:
      weekday-review:
        type: cron
        schedule: "0 9 * * 1-5"
        runOnStart: false
    triggers:
      weekday-review-spawn:
        source: weekday-review
        event: cron:tick
        spawn:
          prompt: "Review all open PRs"
```

## Milestone 1 behavior

### Spawn flow

```text
CLI -> ensure daemon -> POST /sessions
  -> allocate next session id
  -> choose branch
  -> create worktree
  -> apply symlinks
  -> build agent launch command + env
  -> create detached tmux session in worktree
  -> start agent inside tmux
  -> persist flat metadata
  -> return session record
```

### Session model

- User-facing session id stays simple: `<prefix>-N`.
- Store the real `tmux` target in metadata; it may stay equal to session id in `v2`.
- Persist flat key-value metadata or one small JSON file per session. Keep the format direct and human-readable.
- Human `list` reads only the stored session records plus minimal live checks when needed.
- `list --json` stays the raw `SessionView[]` for scripts.

### Kill flow

- Kill the `tmux` session.
- Remove the worktree.
- Mark the session terminal in metadata instead of trying to reconstruct richer state.
- `pause` keeps the worktree and persists `paused`; `complete` removes owned artifacts and persists `completed`.

### Send flow

- Resolve session to `tmux`.
- Clear current input.
- Send literal text or paste buffer for long messages.
- Press Enter.

### Source and trigger flow

- `sources.<id>` owns its module-specific config and emits named events onto a small in-process bus.
- `triggers.<id>` subscribes by `source + event` and reacts with a normal Spur `spawn` or `send`.
- `cron` and `github` are built-in source implementations, not special cases in session logic.

## What to port from current AO

Port behavior, not architecture.

- Use `docs/architecture-v2.md` as product intent only.
- Use `packages/core/src/session-manager.ts` only as reference for spawn ordering and cleanup expectations.
- Use `packages/core/src/metadata.ts` for flat metadata ideas, especially atomic id reservation.
- Use `packages/plugins/workspace-worktree/src/index.ts` for `git fetch`, `git worktree add/remove`, and symlink behavior.
- Use `packages/plugins/runtime-tmux/src/index.ts` for `tmux new-session`, `send-keys`, `paste-buffer`, `capture-pane`, and `kill-session`.
- Use `packages/plugins/agent-claude-code/src/index.ts` only for launch command and environment shaping.
- Use `packages/plugins/agent-codex/src/index.ts` only for launch command and environment shaping.

## What not to port yet

- Any plugin registry or dynamic plugin loading.
- JSONL parsing, cost estimation, and broad metadata hooks outside current built-in behavior.
- Tracker-aware branch naming.
- Rich orchestrator sessions, templated reactions, or project step pipelines.
- Next.js service singletons and dashboard API routes.
- Terminal web transport.

## Working rules

- One feature, one code path.
- No optional abstraction until there is a second real implementation that needs it.
- If a borrowed v1 helper brings more surrounding machinery than code savings, rewrite it smaller in `v2`.
- Prefer plain data structures and explicit modules over framework-like layers.
- Keep docs and prompts lean too; remove explanation that does not constrain behavior.

## Validation

- Always run `pnpm --dir v2 build` after changing Spur code.
- Spur test tiers are fixed:
  `fast` -> `pnpm --dir v2 test`
  `runtime integration` -> `pnpm --dir v2 test:runtime`
  `real-agent smoke` -> `pnpm --dir v2 test:smoke`
- Run `fast` for every Spur code change.
- Run `runtime integration` for CLI, daemon, worktree, `tmux`, transport, and automation runtime boundaries.
- Run `real-agent smoke` for agent launch or prompt delivery changes. Cover both `claude` and `codex`.
- `v2/TEST_SCENARIOS.md` maps each scenario to exactly one tier. Extend it in the same change.

## Acceptance checklist for milestone 1

- `Spur` can start or auto-start a local daemon.
- `spur spawn` creates a worktree, applies symlinks, starts `tmux`, and launches `claude` or `codex`.
- `spur list` shows persisted sessions, runtime summary, and selected-session details, hides `completed` and `killed` by default, and TTY `list` can attach, pause, complete, restore, or kill in place.
- `spur send` reaches the running agent through `tmux`.
- `cron` and `github` sources can emit events and reach normal Spur `spawn` or `send` triggers.
- Current `ao` continues to work unchanged during migration.
