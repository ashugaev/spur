# Spur v1 Deep Research

Date: 2026-03-21
Scope: `v2/` only
Question: what is still missing before Spur can ship a credible first version?

## The Team of 10

1. Product Boundary Cartographer
2. Ruthless v1 Editor
3. CLI Stage Director
4. Daemon SRE
5. Git Worktree Blacksmith
6. Tmux Necromancer
7. Agent Whisperer
8. Signal Ecologist
9. Config Minimalist
10. Launch Captain

Note:
The Product Boundary Cartographer role was filled locally after two external subagent runs failed with an Azure deployment `404` unrelated to this repo.

## Shared Reading of Spur

The team converged on one clear concept:

- Spur is not AO v1.5.
- Spur is a narrow local daemon plus CLI.
- Its public surface is only `spawn`, `list`, `send`.
- Its runtime contract is only `git worktree` or shared repo, detached `tmux`, and `claude` or `codex`.
- Its automation contract is only `cron|github -> events -> triggers -> spawn|send`.

If a proposal widens that shape, it is not v1 finalization work.

## Constellation

```text
                Product Boundary Cartographer
                           |
     CLI Stage Director -- Ruthless v1 Editor -- Launch Captain
               |                 |                    |
        Tmux Necromancer ---- Spur v1 ---- Daemon SRE
               |                 |                    |
        Agent Whisperer -- Git Worktree Blacksmith -- Signal Ecologist
                           |
                    Config Minimalist
```

## High-Level Verdict

Spur already feels like a strong internal tool and a convincing demo.
It does not yet feel like a trustworthy v1 because its happy path is stronger than its contracts around real agents, destructive operator actions, shared/worktree safety, automation persistence, and release proof.

## What Must Be Fixed Before v1

### 1. Real-Agent Support Must Become Truthful

Right now Spur says it supports `claude` and `codex`, but the strongest gaps sit exactly there.

- `codex` preflight is drifting against the real CLI contract.
- real `codex` smoke is still unstable around prompt delivery and slots behavior.
- restore is based on heuristics instead of a persisted native resume identity.
- ready/liveness detection depends on fragile UI text and process-name assumptions.
- auth, install, and native session-state prerequisites are not spelled out clearly.

Load-bearing files:

- `src/preflight.ts`
- `src/agents/claude.ts`
- `src/agents/codex.ts`
- `src/runtime-tmux.ts`
- `src/session-service.ts`
- `test/smoke/real-agents.smoke.test.ts`
- `README.md`

### 2. Operator Safety Must Beat Convenience

The main UI is already `spur list`, so operator safety is part of the product, not polish.

- `k` is too destructive for a single keypress because it can kill the session and remove the worktree.
- `send` can still write into a stopped shell when the agent is gone but `tmux` is alive.
- `Enter` can still attach into a stopped shell instead of steering the operator toward restore.
- `restore` is destructive too early because it kills the current `tmux` session before the new resume path is proven.
- `spur-slots` metadata is underused in `list`, so the one session UI hides the most human-meaningful labels.

Load-bearing files:

- `src/cli.ts`
- `src/cli-view.ts`
- `src/session-service.ts`
- `src/session-slots.ts`
- `test/runtime/cli-lifecycle.runtime.test.ts`

### 3. Workspace and Branch Invariants Need Hard Edges

Spur's workspace path is elegant, but a few boundaries are still too soft for v1.

- shared mode is effectively multi-writer today; there is no guard against two live shared sessions on the same repo path.
- shared mode can record `HEAD` from detached checkouts and feed that value downstream into GitHub matching.
- preflight and explicit branch values are not validated early enough as real git branch names.
- freshness logic is not strict enough on divergent local vs remote branches.
- worktree creation is hard-wired to `origin`; if that is a deliberate v1 rule, it needs to be explicit and documented.

Load-bearing files:

- `src/workspace.ts`
- `src/session-service.ts`
- `src/preflight.ts`
- `src/event-sources/github.ts`
- `README.md`
- `test/fast/workspace.test.ts`
- `test/runtime/cli-lifecycle.runtime.test.ts`

### 4. Daemon and Automation Need an Honest Runtime Contract

Spur is already daemon-backed, so restart, compatibility, and delivery guarantees matter.

- client compatibility is too loose: matching only `apiVersion` and `pid` risks reusing the wrong daemon for the wrong config.
- autostart failures are barely diagnosable because the daemon is detached and silent on failure.
- boot readiness is coupled to sequential source startup; a slow GitHub poll can make startup look broken.
- queued GitHub deliveries and CI retries live only in memory, so restart can lose user-visible automation intent even though snapshots persist.
- there is no supported operator-facing automation status surface for "last poll", "last error", or "queued deliveries".

Load-bearing files:

- `src/client.ts`
- `src/server.ts`
- `src/event-sources/index.ts`
- `src/event-sources/github.ts`
- `src/triggers.ts`
- `src/send-batches.ts`
- `bin/restart-daemon-if-running.mjs`

### 5. Config, Install, and Release Bar Need to Stop Being Fuzzy

Spur is lean, but some of its contract still lives more in code than in docs or tests.

- config silently ignores unknown keys in too many places.
- source validation is still shallow for cron and polling boundaries.
- config discovery rules, path resolution, defaults, id rules, and symlink expectations are not fully documented.
- the install story is still "run from source"; `v2/package.json` is `private`, and README does not define a real first-run path for another user.
- `quality` is not a real release gate because it omits runtime and smoke tiers.

Load-bearing files:

- `src/config.ts`
- `src/types.ts`
- `src/spawn-overrides.ts`
- `README.md`
- `package.json`
- `TEST_SCENARIOS.md`
- `test/fast/config.test.ts`

## What Should Be Added If Time Allows

- A human-readable one-shot TTY snapshot mode for `spur list`, not only live UI or `--json`.
- A tiny `spur doctor` or equivalent first-run self-check for tools, auth, and config.
- GitHub self-noise filtering for bot chatter and self-comments.
- A repo-agnostic smoke path, or at least published repeatable release evidence from the exact smoke environment.

## Anti-Goals

These came up repeatedly as things Spur should not absorb before v1:

- no web UI or dashboard
- no plugin registry or wider AO-style architecture
- no new public commands beyond `spawn`, `list`, `send`
- no wider agent support beyond `claude` and `codex`
- no extra workspace knobs if the current ones can be tightened instead

## Proposed v1 Release Bar

Spur feels ready for v1 when all of this is true:

1. Real `claude` and real `codex` can both pass the promised launch, prompt, and restore contract.
2. `send`, `attach`, `kill`, and `restore` are safe in stopped-shell and destructive-edge cases.
3. shared/worktree boundaries are explicit and fail fast.
4. automation either persists delivery intent across restart, or the docs stop implying that it does.
5. config rejects typos and invalid shapes early.
6. another user can install, authenticate, and bootstrap Spur without reverse-engineering repo-local assumptions.
7. the release gate is explicit:
   - `pnpm --dir v2 build`
   - `pnpm --dir v2 test`
   - `pnpm --dir v2 test:runtime`
   - `pnpm --dir v2 test:smoke` for launch, prompt, preflight, or restore changes

## Recommended Order of Attack

1. Fix real-agent truthfulness first.
   This includes `codex` preflight, `codex` smoke instability, and persisted restore identity.
2. Tighten operator safety next.
   This includes `k`, `send`, `attach`, and restore semantics.
3. Harden workspace boundaries.
   This includes shared-mode locking, detached `HEAD`, branch validation, and strict freshness.
4. Make daemon and automation honest.
   This includes config-aware daemon compatibility, startup diagnostics, and restart-safe delivery intent.
5. Finish the outer shell.
   This includes strict config, docs, install story, and a real release checklist.

## Bottom Line

Spur does not need more product surface to reach v1.
It needs tighter promises around the exact surface it already has.
