---
name: spur
description: Spur orchestrates AI coding agents (claude/codex/cursor/opencode) via CLI, daemon, web UI, or Telegram. Use when spawning, messaging, automating, or configuring a session, tmux pane, or Spur config. Don't use for driving an agent's CLI, or plain git worktree work.
hostInstall: true
---

SPUR

WHAT SPUR IS

  CLI plus a local HTTP daemon, default `127.0.0.1:4310`, plus a web UI.
  "spawn an agent" means this, not the built-in Agent/Task tool.
  Agents `claude`, `codex`, `cursor`, `opencode` launch full-access, each in a detached tmux pane inside a `git worktree`.
  Global fields in a project `spur.yaml` are silently discarded; put them in `~/.spur/config.yaml`.

INTERFACES

  CLI: `spur --help`, then `spur <command> --help`.
  `$SPUR_SESSION_TOOL_DIR` holds the session-bound wrappers; `ls "$SPUR_SESSION_TOOL_DIR"` enumerates them.
  Call each by its explicit `"$SPUR_SESSION_TOOL_DIR/<tool>"` path — a login shell rebuilds `PATH` and drops the dir.
  Session variables: `env | grep '^SPUR_'`.

SAFETY

  A daemon on the default port is someone's production instance. Never `daemon start|stop`, kill, or direct-HTTP a daemon you did not start; never repoint `--config` at `~/.spur/config.yaml`.
  Run non-default-instance CLI calls from a neutral cwd — `spawn`/`list` auto-connect the nearest `spur.yaml` upward from cwd and spawn real sessions.
  Never run `gc --execute` against a data dir you do not own; a bare `gc` is the dry run.
  Never run `cache --prune --yes` on a host running agents you do not own; a bare `cache` or `cache --prune` is a dry run.
  `--expose-web` binds `0.0.0.0`, public.
  Agents run full-access — any untrusted prompt from Telegram, GitHub, or Jira runs arbitrary commands as the daemon user.
  Start dev servers with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, never a bare dev-server command.
  Read a sidecar's port with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports`, never by grepping `/proc` or session state.

DOCS

  Commands, daemon HTTP routes, session tools and variables: https://raw.githubusercontent.com/ashugaev/spur/main/docs/commands.md
  Config fields: https://raw.githubusercontent.com/ashugaev/spur/main/docs/configuration.md

EDITING THIS FILE

  Reader has no checkout. Each pointer above is a raw URL, never a relative path.
  Context only. Mechanism, repo internals, and any command, config field, or workflow another doc owns stay out — link the doc.
