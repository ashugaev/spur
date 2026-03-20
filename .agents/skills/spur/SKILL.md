---
name: spur
description: "Use when working on Spur, the lean v2 orchestrator in `v2/`. Covers its current CLI, daemon, tmux/worktree session flow, cron sources/triggers, config shape, and validation rules."
---

# Spur

## Use this skill when

- The task touches `v2/`.
- The task is about Spur CLI, local daemon, session lifecycle, `tmux`, `git worktree`, cron source/trigger flow, or the Spur config.

## Fixed facts

- `v2/` is `Spur`.
- Spur is separate from the current `ao`.
- Spur is CLI plus local HTTP daemon. No UI layer in the current milestone.
- Current command surface: `info`, `spawn`, `list`, `get`, `send`, `kill`.
- `spawn` has one form only:
  `spur spawn <project> <prompt...> [--agent claude|codex] [--branch <name>]`
- Supported agents are only `claude` and `codex`.
- Both agents start with full access by default:
  `claude --dangerously-skip-permissions`
  `codex --dangerously-bypass-approvals-and-sandbox`
- Workspace setup is only:
  `git worktree` + configured symlinks + detached `tmux` + agent launch.
- Minimal automation is only:
  `sources -> events -> triggers -> spawn`
- Current built-in source type is only `cron`.
- `cron` emits `cron:tick`.
- `runOnStart` defaults to `false`.

## Current config shape

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

## Main flow

```text
spawn
  -> ensure daemon
  -> POST /sessions
  -> allocate session id
  -> create worktree
  -> apply symlinks
  -> start tmux
  -> launch agent
  -> send initial prompt
  -> persist session metadata
```

## Cron flow

```text
cron source
  -> emit cron:tick
  -> matching trigger
  -> normal Spur spawn
```

## Working rules

- Keep Spur lean. One task, one interface, one code path.
- Do not keep alternative command forms.
- Do not add speculative fields or helper layers.
- If code is not part of current Spur behavior, remove it.
- Defaults belong at config parsing boundaries, not inside runtime hot paths.

## Validation

- Always run `pnpm --dir v2 build` after changing Spur code.
- If only `v2/` changed, exercise the touched `spur` CLI commands through positive and negative paths.
- Run the impacted scenarios from `v2/TEST_SCENARIOS.md`.
- If the change touches spawn or prompt delivery, test both `claude` and `codex`.
- If the change touches cron, test `runOnStart` and scheduled tick behavior.
