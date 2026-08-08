---
name: spur
description: Spur orchestrates AI coding agents (claude/codex/cursor) in detached tmux sessions inside git worktrees, driven by CLI, a local HTTP daemon, a web UI, or Telegram. Use when spawning, messaging, or automating Spur sessions, or when reading or writing Spur config. Don't use for driving an agent's own CLI directly, or for plain git worktree work.
---

SPUR

  Sections through SAFETY describe Spur anywhere, no repo path needed. Sections after that reference this repo.

WHAT SPUR IS

  CLI plus a local HTTP daemon, default `127.0.0.1:4310`, plus a web UI (default `5555`, no runtime logic of its own). "spawn an agent" means this, not the built-in Agent/Task tool.
  Agents `claude`, `codex`, `cursor` launch full-access, each in a detached tmux pane inside a `git worktree`. Command reference: `docs/commands.md`. Config field reference: `docs/configuration.md` — both own the detail, link never restate.

INTERFACES

  CLI: `spur --help`, then `spur <command> --help`. Never hard-code a command list — `docs/commands.md` Surface section is the closest static list and can drift.
  Daemon HTTP API is the same surface the web UI drives; see `docs/commands.md`.
  Inside a live session `$SPUR_SESSION_TOOL_DIR` is first on `PATH`: holds `spur` (bound to this session's config), `spur-slots`, `spur-sidecar`, `spur-self-destruct`, plus `spur-branch` and a push-blocking `git` wrapper when `branchNaming.regex` is set. Also set: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SLOT_COMMAND`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_REAL_HOME`.

CONFIG FOOTGUNS

  Full field reference and example: `docs/configuration.md`. Cross-file invariants and footguns:

  Restrict project `spur.yaml` to project definitions. Put global fields in `~/.spur/config.yaml`; project files ignore global fields before semantic parsing.
  Codex model cache lookup and session staging: `docs/configuration.md`, `v2/src/agents/models.ts`, `v2/src/agents/codex.ts`.
  Provider reasoning effort policy and launch wiring: `docs/configuration.md`, `v2/src/agents/`, `v2/src/session-service.ts`.
  Admission cap: resolution contract `docs/configuration.md#admission-control`; implementation `v2/src/config.ts`.
  Sidecar reap: `sidecarGc` (on by default) kills an idle or unowned non-MCP project sidecar, workspace-wide; an established connection on a reserved port vetoes every reap rule. Rule order `docs/configuration.md#sidecar-reaping`; implementation `v2/src/sidecars/policy.ts`.
  Sidecar port overlap: a sidecar start refuses when another workspace of the same project holds a live pane on an overlapping declared port range — no reuse, no auto-reap. Contract `docs/configuration.md#sidecar-reaping`; implementation `v2/src/session-service.ts` `refuseOverlappingCrossWorkspaceSidecar`.
  Registry merge order: instance config first, then connected configs in stored order. First project id or `sessionPrefix` owner wins; later colliding configs stay registered and retry after ownership or order changes.
  Registry scans retain live-parent misses and lookup errors, prune dead-parent paths, and protect the instance path. One canonical problem path emits one warning per daemon lifetime.
  A running session overrides its project only from the `spur.yaml` in its own session directory — the worktree root, or `path` when `worktree: false`. Never a parent's. Without one it uses the project as the daemon has it.
  `emitExisting: true` on a work-item source (`github` with `query`, `sentry`, `github-ci`) emits the suppressed first-poll backlog once, capped at 10.

SAFETY

  A daemon on the default port is someone's production instance unless proven otherwise. Never `spur daemon start|stop`, kill, or issue direct HTTP calls against a daemon you did not start.
  Do not repoint `--config` at the instance config `~/.spur/config.yaml` to widen reach; use the `spur` already on `PATH`. Do not kill processes or ports you did not start.
  A config outside the default instance config path (`~/.spur/config.yaml`) may not claim port `4310` or dataDir `~/.spur`, explicit or inherited by omission; `daemon start|stop|restart` all refuse rather than let a non-default config bind or target the production slot. Same three verbs also refuse a non-existent `--config`/`SPUR_CONFIG` path unless it is that default, without bootstrapping one.
  Never run `spur gc --execute` against a data dir you do not own. It removes worktrees and archives records. Point `--config` at a temp data dir for development; a bare `spur gc` is a dry run and the only safe form elsewhere.
  The web UI binds `127.0.0.1`, plus the tailnet IP once `spur init` brings Tailscale up (default on); `--expose-web` binds `0.0.0.0` and is public. Agents run full-access, so any prompt reaching one runs arbitrary commands as the daemon user — treat each source (Telegram, GitHub comments, Jira) as untrusted input.
  For dev servers and test helpers inside a session use `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, not a bare `pnpm dev` / `next dev`: Spur reserves the port, ties teardown to the session, and captures output into the session log.

IN THIS REPO

  Install from source: `docs/install-from-source.md`. HTTPS on a tailnet host, required for voice: `docs/https-tailscale.md`. Claude account rotation: `references/claude-auth-rotation.md`.
  Admission and memory policy: `docs/configuration.md#admission-control`.
  Validation: `pnpm --dir v2 test` (fast, each Spur code change), `pnpm --dir v2 test:runtime` (CLI, daemon start, transport, lifecycle, worktree, tmux), `pnpm --dir v2 test:smoke` (real agent launch or prompt delivery). `pnpm --dir v2 build` after changing Spur code.
  Test against the `isolated-daemon` / `isolated-ui` sidecars, never the production daemon. `scripts/spur-isolated-daemon.sh` is the sanctioned launcher — it assigns a non-default port/dataDir so it never trips the bind guard. Isolated configs inherit `voice` from the user config; server, data, and tmux stay isolated. Add key branches in `v2/src/isolated-instance-config.ts` to propagate more.

UPDATING THIS SKILL

  Update on any change to CLI commands/flags, daemon HTTP routes, config keys/defaults, source/event names, in-session tool/env contracts, or agent-facing safety rules. Update `docs/commands.md` and `docs/configuration.md` in the same change, and mirror `.agents/skills/spur/SKILL.md` and `.claude/skills/spur/SKILL.md`.
  Skip: internal refactors, file moves, tests, UI styling. Sections through SAFETY stay repo-independent; repo-relative paths live only in IN THIS REPO.
  Verify each stated default against source at edit time and name the file checked: daemon/config defaults `v2/src/config.ts`, web UI port default `v2/src/ports.ts`, source types/event names `v2/src/config.ts` and `v2/src/types.ts`, agent launch flags `v2/src/agents/`, project-config merge `v2/src/registry.ts`.
