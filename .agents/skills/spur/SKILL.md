---
name: spur
description: Spur orchestrates AI coding agents (claude/codex/cursor/opencode) via CLI, daemon, web UI, or Telegram. Use when spawning, messaging, or configuring a session, worktree, tmux pane, or Spur config. Don't use for driving an agent's own CLI, or git worktree work.
---

SPUR

  Sections through SAFETY describe Spur anywhere. Sections after SAFETY reference the Spur repo.

WHAT SPUR IS

  CLI plus a local HTTP daemon, default `127.0.0.1:4310`, plus a web UI (default `5555`, no runtime logic of its own).
  "spawn an agent" means this, not the built-in Agent/Task tool.
  Agents `claude`, `codex`, `cursor`, `opencode` launch full-access, each in a detached tmux pane inside a `git worktree`.
  Global fields in a project `spur.yaml` are silently discarded; put them in `~/.spur/config.yaml`.

INTERFACES

  CLI: `spur --help`, then `spur <command> --help`; the daemon HTTP API is the same surface the web UI drives.
  `$SPUR_SESSION_TOOL_DIR` holds `spur`, `spur-slots`, `spur-sidecar`, `spur-self-destruct`, plus `spur-branch` and a push-blocking `git` wrapper when `branchNaming.regex` is set.
  Call each tool by its explicit `"$SPUR_SESSION_TOOL_DIR/<tool>"` path. Also set: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SLOT_COMMAND`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_REAL_HOME`.

SAFETY

  A daemon on the default port is someone's production instance. Never `daemon start|stop`, kill, or direct-HTTP a daemon you did not start; never repoint `--config` at `~/.spur/config.yaml`.
  Run non-default-instance CLI calls from a neutral cwd — `spawn`/`list` auto-connect the nearest `spur.yaml` upward from cwd and spawn real sessions.
  Never run `gc --execute` against a data dir you do not own; a bare `gc` is the dry run.
  Never run `cache --prune --yes` on a host running agents you do not own; a bare `cache` or `cache --prune` is a dry run.
  `--expose-web` binds `0.0.0.0`, public. Agents run full-access — any prompt from Telegram, GitHub, or Jira is untrusted input running arbitrary commands as the daemon user.
  Start dev servers with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, never a bare dev-server command.
  Read a sidecar's port with the same binary's `ports` subcommand, never by grepping `/proc` or session state.

DOCS

  Full command reference, incl. daemon HTTP routes: `docs/commands.md`.
  Config field reference: `docs/configuration.md`. Discover live commands via `spur --help`, then `spur <command> --help`.

SPUR REPO (https://github.com/ashugaev/spur)

  Install from source: `docs/install-from-source.md`. HTTPS on a tailnet host, required for voice: `docs/https-tailscale.md`. Claude account rotation: `references/claude-auth-rotation.md`.
  Validation: `pnpm --dir v2 test` (fast), `test:runtime` (daemon/tmux/worktree), `test:smoke` (real agent launch); `pnpm --dir v2 build` after any code change.
  Test against `isolated-daemon`/`isolated-ui`, never the production daemon; launcher `scripts/spur-isolated-daemon.sh`.

UPDATING

  CLI/routes/config keys/source or event names/in-session contracts/safety rules changing -> update this file, `docs/commands.md`, `docs/configuration.md`, and both mirrors (`.claude/skills/spur/SKILL.md`, `.agents/skills/spur/SKILL.md`).
  Skip: internal refactors, file moves, tests, UI styling.
