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
- `v2` has its own CLI, YAML config, state directory, daemon runtime, and API surface.
- CLI is an HTTP client over a local daemon and auto-starts that daemon when needed.
- `spawn` is positional: `spur spawn <project> <prompt...>`, with optional `agent` and `branch`.
- Milestone 1 session ops are only: `spawn`, `list`, `get`, `send`, `kill`, `health/info`.
- Workspace bootstrap is only: `git worktree` plus configured `symlinks`.
- Supported agents for now: `claude` and `codex`.
- Both supported agents start with full access by default:
  `claude --dangerously-skip-permissions` and
  `codex --dangerously-bypass-approvals-and-sandbox`.
- Minimal automation is allowed only as project-local `sources -> events -> triggers -> spawn`.
- The first built-in source is `cron`.
- Do not write speculative code in `v2`. If a field, branch, or helper is not used by current Spur behavior, remove it.
- No UI, dashboard, SSE, mobile, or terminal-web layer.
- No tracker, PR, SCM, notifier, reaction, step/pipeline, or poll-loop automation yet.
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
- `list/get` read only the stored session records plus minimal live checks when needed.

### Kill flow

- Kill the `tmux` session.
- Remove the worktree.
- Mark the session terminal in metadata instead of trying to reconstruct richer state.

### Send flow

- Resolve session to `tmux`.
- Clear current input.
- Send literal text or paste buffer for long messages.
- Press Enter.

### Source and trigger flow

- `sources.<id>` owns its module-specific config and emits named events onto a small in-process bus.
- `triggers.<id>` subscribes by `source + event` and reacts with a normal Spur `spawn`.
- `cron` is the first source implementation, not a special case in session logic.

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
- Agent activity detection, JSONL parsing, cost estimation, PR metadata hooks, or restore semantics.
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

## Acceptance checklist for milestone 1

- `Spur` can start or auto-start a local daemon.
- `spur spawn` creates a worktree, applies symlinks, starts `tmux`, and launches `claude` or `codex`.
- `spur list` and `spur get` show persisted sessions.
- `spur send` reaches the running agent through `tmux`.
- `spur kill` tears down `tmux` and removes the worktree.
- `cron` sources can emit events and spawn normal Spur sessions through triggers.
- Current `ao` continues to work unchanged during migration.
