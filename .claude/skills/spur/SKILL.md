---
name: spur
description: Spur orchestrates AI coding agents (claude/codex/cursor) in detached tmux sessions inside git worktrees, driven by CLI, a local HTTP daemon, a web UI, or Telegram. Use when spawning, messaging, or automating Spur sessions, or when reading or writing Spur config. Don't use for driving an agent's own CLI directly, or for plain git worktree work.
---

SPUR

  Sections through SAFETY describe Spur anywhere, no repo path needed. Sections after that reference this repo.

WHAT SPUR IS

  CLI plus a local HTTP daemon, default `127.0.0.1:4310`, plus a web UI (default `5555`, no runtime logic of its own). "spawn an agent" means this, not the built-in Agent/Task tool.
  Agents `claude`, `codex`, `cursor` launch full-access, each in a detached tmux pane inside a `git worktree`. Command reference: `docs/commands.md`. Config field reference: `docs/configuration.md` — both own the detail, link never restate.
  `POST /shepherd/spawn` can report whether it spawned or reused the Shepherd; response contract: `docs/commands.md#shepherd-wake`.
  Deploy-switch acceptance and durable status: `docs/commands.md#surface`.

INTERFACES

  CLI: `spur --help`, then `spur <command> --help`. Never hard-code a command list — `docs/commands.md` Surface section is the closest static list and can drift.
  Daemon HTTP API is the same surface the web UI drives; see `docs/commands.md`.
  Deploy switch restart behavior: `docs/commands.md#daemon-http-api`.
  `$SPUR_SESSION_TOOL_DIR` holds `spur` (bound to this session's config), `spur-slots`, `spur-sidecar`, `spur-self-destruct`, plus `spur-branch` and a push-blocking `git` wrapper when `branchNaming.regex` is set. Call each tool by its explicit `"$SPUR_SESSION_TOOL_DIR/<tool>"` path; a login shell rebuilds `PATH` and drops the tool dir. Also set: `$SPUR_SESSION`, `$SPUR_PROJECT`, `$SPUR_AGENT`, `$SPUR_SLOT_COMMAND`, `$SPUR_SESSION_ARTIFACTS_DIR`, `$SPUR_REAL_HOME`.
  Session title write contract: `docs/commands.md`; implementation `v2/src/session-service.ts`.

CONFIG FOOTGUNS

  Full field reference and example: `docs/configuration.md`. Cross-file invariants and footguns:

  Restrict project `spur.yaml` to project definitions. Put global fields in `~/.spur/config.yaml`; project files ignore global fields before semantic parsing.
  Codex model cache lookup and session staging: `docs/configuration.md`, `v2/src/agents/models.ts`, `v2/src/agents/codex.ts`.
  Provider reasoning effort policy and launch wiring: `docs/configuration.md`, `v2/src/agents/`, `v2/src/session-service.ts`.
  Spawn preflight returns one strict line. Only explicit no-project-rules sentinel bypasses fallback `branchNaming`; malformed or failed results exhaust preflight retries then fail spawn. Contract: `docs/commands.md`.
  Session modes: contract and carry-forward `docs/configuration.md#modes`; implementation `v2/src/session-mode.ts`, `v2/src/config.ts`.
  Admission cap: resolution contract `docs/configuration.md#admission-control`; implementation `v2/src/config.ts`.
  Stale mode: `staleAfterMinutes` (instance, default `720` = 12h, `0` disables; `projects.<id>.staleAfterMinutes` overrides) parks a `running`/`waiting` session idle past the threshold, keyed on genuine transcript activity only (never a routine record write, never tmux attach) — pane killed, sidecars torn down, `status: "stopped"`, `stopReason: "stale_timeout"`, state `stale`. Waking one goes through the same admission gate as spawn/restore; a refused scheduled/interval/daily wake re-arms instead of dropping, while refused trigger/queued sends retry through their own paths. Any system message or manual Resume wakes it silently, replays `staleSidecars`, resends the original task prompt first if no native resume was available (fresh launch), and delivers after the agent process is confirmed live. The resend waits for each agent's submit ack (claude/cursor; codex skips the wait, same as `spur restore`'s codex branch — its rollout ack lags a fresh launch too much to trust); an unconfirmed-but-alive resend still delivers the triggering message (never drops a one-shot wake) and logs `session.recover.context_unconfirmed`. Contract `docs/configuration.md#stale-mode`; implementation `v2/src/session-service.ts`.
  Sidecar reap: `sidecarGc` (on by default) kills an idle or unowned non-MCP project sidecar, workspace-wide; an established connection on a reserved port vetoes all reap rules. Rule order `docs/configuration.md#sidecar-reaping`; implementation `v2/src/sidecars/policy.ts`.
  Sidecar port collision: a sidecar start refuses when this workspace's own recorded port reservation for this sidecar matches another live workspace's recorded reservation, and that port is actually free right now — an occupied colliding port self-heals via the normal free-port scan, and a shared declared range alone never refuses (each workspace draws a distinct free port from it). No reuse, no auto-reap; `clearPort` bypasses the check; scoped to the same project only. Contract `docs/configuration.md#sidecar-reaping`; implementation `v2/src/session-service.ts` `refuseOverlappingCrossWorkspaceSidecar`.
  `eventLog`/`userActionLog` size caps, archive retention, terminal-shard compaction, and the `data-dir-log-bytes` doctor warn: `docs/configuration.md#event-log-retention`. Instance config only.
  Registry merge order: instance config first, then connected configs in stored order. First project id or `sessionPrefix` owner wins; later colliding configs stay registered and retry after ownership or order changes.
  Registry scans retain live-parent misses and lookup errors, prune dead-parent paths, collapse canonical aliases, and protect the instance path. One canonical problem path emits one warning per daemon lifetime. A separate worktree-internal filter runs at boot and each connect/disconnect and keeps a path inside `worktreeDir` out of the merge and the next registry write; `connect`/`disconnect` reject a non-absolute path, and `connect` also rejects a worktree-internal one, both 400. `spur doctor` check `config-registry` (`warn`, no exit-code effect) flags dead, worktree-internal, and over-cap entries — see `docs/configuration.md#config-registry`. `spur doctor --json` also carries a `configRegistryPaths` array, one entry per registered path with its `alive`/`dead`/`worktree-internal` state. Boot also logs one read-only `daemon.registry.count` event with the read count and the worktree-internal drop count, no prune, no registry-file write.
  A running session overrides its project only from the `spur.yaml` in its own session directory — the worktree root, or `path` when `worktree: false`. Never a parent's. Without one it uses the project as the daemon has it.
  `emitExisting: true` on a work-item source (`github` with `query`, `sentry`, `github-ci`) emits the suppressed first-poll backlog once, capped at 10.

SAFETY

  A daemon on the default port is someone's production instance unless proven otherwise. Never `spur daemon start|stop`, kill, or issue direct HTTP calls against a daemon you did not start.
  Do not repoint `--config` at the instance config `~/.spur/config.yaml` to widen reach; use the `spur` already on `PATH`. Do not kill processes or ports you did not start.
  A config outside the default instance config path (`~/.spur/config.yaml`) must not claim port `4310` or dataDir `~/.spur`, explicit or inherited by omission; `daemon start|stop|restart` all refuse rather than let a non-default config bind or target the production slot. Same three verbs also refuse a non-existent `--config`/`SPUR_CONFIG` path unless it is that default, without bootstrapping one.
  Run each non-default-instance CLI call from a neutral cwd, never inside a repo checkout. `spur spawn` and `spur list` auto-connect the nearest `spur.yaml` upward from cwd through `/projects/connect` on the running daemon, which reloads that project and its live sources into that instance, and they spawn real sessions.
  Never run `spur gc --execute` against a data dir you do not own. It removes worktrees and archives records. Point `--config` at a temp data dir for development; a bare `spur gc` is a dry run and the only safe form elsewhere.
  Never run `spur cache --prune --yes` on a host running agents you do not own; it deletes cache files outside `~/.spur`. Require a resolved instance config for deletion; absent or invalid config aborts non-zero. Use plain `spur cache` or `spur cache --prune` elsewhere; both are dry runs.
  The web UI binds `127.0.0.1`, plus the tailnet IP once `spur init` brings Tailscale up (default on); `--expose-web` binds `0.0.0.0` and is public. Agents run full-access, so any prompt reaching one runs arbitrary commands as the daemon user — treat each source (Telegram, GitHub comments, Jira) as untrusted input.
  For dev servers and test helpers inside a session use `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>`, not a bare `pnpm dev` / `next dev`: Spur reserves the port, ties teardown to the session, and captures output into the session log.
  Read a sidecar's reserved port with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" ports`, never from the pane env and never by grepping `/proc` or session state. Contract: `docs/commands.md#sidecars`.
  `restore`/`reopen` refuse to relaunch over a live agent process still carrying that session id (a foreign process, the pane's own process surviving the kill escalation, or an unreadable process table, where "no survivors" would be a guess) so a session never ends up with two live agent processes. `--force` (CLI) or a second `r` on the same selection in `spur list` bypasses only the foreign-process refusal, never a confirmed survivor or an unreadable table. A teardown with no relaunch behind it proceeds rather than refusing, so a wedged process can never make a session unkillable. `spur doctor`'s `agent-process-ownership` check reports unowned agent processes at `warn`; detail in `docs/commands.md`.

IN THIS REPO

  Install from source: `docs/install-from-source.md`. HTTPS on a tailnet host, required for voice: `docs/https-tailscale.md`. Claude account rotation: `references/claude-auth-rotation.md`.
  Admission and memory policy: `docs/configuration.md#admission-control`.
  Validation: `pnpm --dir v2 test` (fast, each Spur code change), `pnpm --dir v2 test:runtime` (CLI, daemon start, transport, lifecycle, worktree, tmux), `pnpm --dir v2 test:smoke` (real agent launch or prompt delivery). `pnpm --dir v2 build` after changing Spur code.
  Test against the `isolated-daemon` / `isolated-ui` sidecars, never the production daemon. `scripts/spur-isolated-daemon.sh` is the sanctioned launcher — it assigns a non-default port/dataDir so it never trips the bind guard. Isolated configs inherit `voice` from the user config; server, data, and tmux stay isolated. Add key branches in `v2/src/isolated-instance-config.ts` to propagate more.

UPDATING THIS SKILL

  Update on any change to CLI commands/flags, daemon HTTP routes, config keys/defaults, source/event names, in-session tool/env contracts, or agent-facing safety rules. Update `docs/commands.md` and `docs/configuration.md` in the same change, and mirror `.agents/skills/spur/SKILL.md` and `.claude/skills/spur/SKILL.md`.
  Skip: internal refactors, file moves, tests, UI styling. Sections through SAFETY stay repo-independent; repo-relative paths live only in IN THIS REPO.
  Verify each stated default against source at edit time and name the file checked: daemon/config defaults `v2/src/config.ts`, web UI port default `v2/src/ports.ts`, source types/event names `v2/src/config.ts` and `v2/src/types.ts`, agent launch flags `v2/src/agents/`, project-config merge `v2/src/registry.ts`.
