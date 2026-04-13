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
- Change only `v2/` for Spur work. Treat `v1` and the current `ao` tree as legacy reference-only and do not wire new Spur behavior to them.
- Spur is CLI plus local HTTP daemon. `packages/web` is the only supported UI layer (thin Next.js frontend over daemon HTTP API).
- Current human-facing command surface: `spawn`, `list`, `send`, `pause`, `complete`, `kill`.
  `daemon start` stays as the internal daemon command and is hidden from `spur --help`.
- `spawn` has one form only:
  `spur spawn <project> <prompt...> [--agent claude|codex] [--branch <name>] [--step <label> ...] [--worktree [defaultBranch] | --shared]`
- Supported agents are only `claude` and `codex`.
- Both agents start with full access by default:
  `claude --dangerously-skip-permissions`
  `codex --dangerously-bypass-approvals-and-sandbox`
- Workspace setup is only:
  `git worktree` + configured symlinks + detached `tmux` + agent launch.
- `list` hides `completed` and `killed` sessions by default.
- Minimal automation is only:
  `sources -> events -> triggers -> spawn|send`
- Current built-in source types are `cron`, `github`, and `service`.
- Spur supports a lean sequential startup pipeline:
  one task prompt plus optional `steps` phase labels such as `research`, `develop`, and `test`.
- Project config may define default `spawn.steps`. Manual/API/trigger `steps` override that default.
- Later phases are sent only after the agent returns to its prompt.
- `cron` emits `cron:tick`.
- `github` emits `github:changes_requested`, `github:ci_failed`, `github:comment`, `github:merge_conflict`.
  `github:comment` covers top-level PR comments and review comments/replies.
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
    spawn:
      steps: [research, test]
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
          steps:
            - "research"
            - "develop"
            - "run $code-simplifier"
            - "test"
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
  -> send task prompt or first staged phase
  -> auto-send later phases after each prompt return
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

## CLI Convention

- Default to human-first output. Structured commands expose `--json` for scripts.
- Use one theme object only in code.
  brand accent = `#f04c4c` for ids and tiny loading frames
  brand mark = `𖤓` for help headers, runtime summary lines, and spinner frames
  status dot palette = green for `active|ready`, yellow for `idle|waiting_input|spawning`, red for `errored`, gray for `killed|exited`
- Use only four visual primitives: accent, bold, dim, whitespace.
- Do not use boxes, wide tables, rainbow status colors, or decorative aliases for states.
- Use `@clack/prompts` only for transient UI:
  spinner, select, log, note
- Keep data rendering custom and flat.
  `list` is the reference card renderer.
- Prefer dense stacked cards:
  primary line = `id`, colored status dot, state, project, agent, branch
  secondary line = `updated`, runtime/worktree facts, and at most one short exceptional hint
- `list` is the only session UI.
  On a TTY it shows runtime summary, the live selector, and selected-session details; `Enter` attaches in place, `p` pauses, `c` completes, `r` restores a restorable exited session, `k` kills, and `Esc` quits.
  Non-TTY `list` stays a one-shot runtime summary plus session cards.
- Never silently retarget `Enter`, `p`, `c`, `r`, or `k` after refresh. If the selected id disappears, require explicit reselection.
- Empty states should be one sentence plus one dim next-step hint.
- Optional animation is only a one-line transient spinner during wait states, cleared before final output.

## Deployment (openclaw-dev VM)

- VM: `openclaw-dev`, Tailscale IP `100.80.107.19`, public IP `136.107.236.142`
- Nothing binds to `0.0.0.0`. All services on loopback or Tailscale IP only.
- Instance config: `~/.spur/config.yaml`
- Project config: `~/projects/ao/spur.yaml`

Port map:

| Service | Bind address | Port |
|---------|-------------|------|
| Daemon API | `127.0.0.1` | 4310 |
| Next.js (web) | `127.0.0.1` | 3012 |
| Terminal WS | `127.0.0.1` | 14801 |
| Nginx proxy | `127.0.0.1` + `100.80.107.19` | 5555 |

- Systemd units: `spur-daemon.service`, `spur-web.service`
- Nginx config: `/etc/nginx/sites-enabled/spur-ao`
- Deploy: `pnpm main:deploy` (pulls main, builds, restarts services)
- `DIRECT_TERMINAL_PUBLIC_PORT=443` matches the external browser origin (Tailscale serve terminates TLS on 443 and forwards to nginx:5555), so the terminal WS URL stays same-origin.
- Full deploy doc: `docs/ubuntu-vm-deploy.md`

## Validation

- Spur uses three test tiers:
  `fast` -> `pnpm --dir v2 test` for mocked and in-process coverage. This is the default root `pnpm test` path and must stay fast.
  `runtime integration` -> `pnpm --dir v2 test:runtime` for the built CLI, daemon, `git`, worktree, `tmux`, and process boundaries with fake `claude`, `codex`, and `gh`.
  `real-agent smoke` -> `pnpm --dir v2 test:smoke` for narrow real-agent spawn and send checks. It auto-skips when `tmux`, binaries, or API keys are missing.
- Always run `pnpm --dir v2 build` after changing Spur code.
- Run `fast` for every Spur code change.
- Run `runtime integration` when touching CLI, daemon startup, client transport, session lifecycle, worktree setup, `tmux`, or automation runtime boundaries.
- Run `real-agent smoke` when touching agent launch or prompt delivery. Cover both `claude` and `codex`.
- Exercise the touched `spur` CLI commands through positive and negative paths at the cheapest tier that still crosses the changed boundary.
- Keep queueing, dedupe, and validation logic in `fast`; keep source, process, and `tmux` boundaries in `runtime integration`.
- `v2/TEST_SCENARIOS.md` maps each scenario to exactly one tier. Add new scenarios in the same change and rerun the impacted ones.
