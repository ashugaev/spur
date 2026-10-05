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
  `$SPUR_SESSION_TOOL_DIR` holds the session-bound wrappers; `ls "$SPUR_SESSION_TOOL_DIR"` enumerates them. Call each as `"$SPUR_SESSION_TOOL_DIR/<tool>"`, never bare.
  Session variables: `env | grep '^SPUR_'`.
  Agent launch identity contract: `docs/commands.md#session-tools-and-environment`.
  Automatic reminder limits: `docs/configuration.md#automatic-reminders`.
  Spur ToDo: ledger starts empty, no code path seeds an item; the agent adds one item per step, before the step, and resolves it after. Empty or open/held work refuses an agent's own completion, self-destruct, and handoff — `todo_ledger_empty`/`todo_open_work` (409); a human `complete`/`handoff` from the CLI or UI is never blocked. Contract: `docs/commands.md#todo`.
  Telegram: agents send with `"$SPUR_SESSION_TOOL_DIR/spur" source reply`. Reply routing: `docs/configuration.md#telegram-binding`; command: `docs/commands.md#source-reply`.
  Stop unwanted auto-pings with `spur auto-ping unsubscribe`. A thread that keeps coming back takes `--thread`; `--event` binds to one emitted occurrence only. Scopes and resume: `docs/commands.md#auto-ping`; API: `docs/daemon-api.md`.

SAFETY

  A daemon on the default port is someone's production instance. Never `daemon start|stop`, kill, or direct-HTTP a daemon you did not start; never repoint `--config` at `~/.spur/config.yaml`.
  Run non-default-instance CLI calls from a neutral cwd — `spawn`/`list` auto-connect the nearest `spur.yaml` upward from cwd and spawn real sessions.
  Never run `gc --execute` against a data dir you do not own; a bare `gc` is the dry run.
  Never run `cache --prune --yes` on a host running agents you do not own; a bare `cache` or `cache --prune` is a dry run.
  Never run `disk-gc --execute` (or `--browser-revisions`) on a host running agents you do not own; a bare `disk-gc` is the dry run.
  `--expose-web` binds `0.0.0.0`, public.
  Agents run full-access — any untrusted prompt from Telegram, GitHub, Jira, or webhook runs arbitrary commands as the daemon user.
  Token budgets, session overrides, and installed Cursor hook: docs/configuration.md. Unknown usage never blocks execution.
  Start dev servers with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, never a bare dev-server command.
  Read ports with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports`; Open contract: docs/commands.md#sidecars. Never grep `/proc` or session state for ports.

DOCS

  Doc index: https://raw.githubusercontent.com/ashugaev/spur/main/README.md
  Any path under `docs/` resolves as https://raw.githubusercontent.com/ashugaev/spur/main/<path>
  Commands, session tools and variables: docs/commands.md
  Daemon HTTP routes, pre-flight batches and session lifecycle receipts: docs/daemon-api.md
  Config: docs/configuration.md; events: docs/configuration.md#events
  Select reasoning effort per agent or session: docs/commands.md, docs/configuration.md, docs/daemon-api.md.
  Automatic updates and retry policy: docs/configuration.md#auto-update

EDITING THIS FILE

  Reader has no checkout; resolve each doc path through the rule above, never a relative link.
  Context only, never mechanism, repo internals, or a command/config field/workflow another doc owns.
