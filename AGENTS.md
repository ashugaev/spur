# Local Reminders

- Before marking any implementation complete, always run the relevant package `build` command(s) and fix any failures.

## Lean Defaults

- Keep instructions lean: include only constraints that materially change implementation.
- Think twice, write once. Do not add code, commands, docs, or instructions until the shorter version is clearly insufficient.
- Keep commands, docs, and prompts minimal. Prefer the shortest form that still preserves correctness and clarity.
- Absolute local filesystem paths in docs and comments are an antipattern. Prefer relative paths; if that is not practical, use path placeholders or `~/`-style examples instead of machine-specific paths.
- Do not write anything for the future. No speculative hooks, no placeholder branches, no config fields, no docs sections for behavior that does not exist yet.
- If code is not functional in the current product behavior, delete it instead of keeping it around for later.
- Do not keep two different ways to solve the same task. Pick one interface, one code path, and remove the alternate form.
- Prefer one clear path per feature. Avoid parallel abstractions, compatibility shims, and fallback flows unless they are required for correctness right now.
- Prefer narrow types and explicit config shapes. In TypeScript, use discriminated unions and validated objects instead of index-signature bags.
- Apply defaults once at the boundary. Do not scatter re-defaulting and fallback branches through the runtime path.
- In core logic, fail fast instead of adding fallback behavior. Limit fallback handling to cleanup around external tools and teardown paths.
- `v2/` is `Spur`. Use `Spur` as the name of the new orchestrator in code, config, docs, and CLI surfaces.
- For `v2/` migration planning or implementation, use `$migrate-orchestrator-v2`.
- `AGENTS.md` and `CLAUDE.md` must stay in sync. If you add or change a durable instruction in one, mirror it in the other in the same change.

## Spur (`v2/`)

- `Spur` is the lean `v2/` orchestrator. Treat its interface as fixed unless the user asks to change it.
- `Spur` is CLI plus local HTTP daemon. There is no UI layer in the current milestone.
- The current `Spur` command surface is: `health`, `info`, `spawn`, `list`, `get`, `send`, `kill`.
- `spawn` is positional: `spur spawn <project> <prompt...>` with optional `--agent` and `--branch`.
- Workspace setup in `Spur` is only: `git worktree`, configured symlinks, detached `tmux`, then agent launch.
- Supported agents in `Spur` are only `claude` and `codex`.
- Both `Spur` agents must launch with full access by default:
  `claude --dangerously-skip-permissions` and
  `codex --dangerously-bypass-approvals-and-sandbox`.

## Spur Validation

- If you change `Spur` CLI, daemon, agent launch, worktree setup, tmux behavior, or session lifecycle, you must run the relevant `Spur` scenarios yourself before marking the work complete.
- Minimum `Spur` validation is: positive path for every touched command, negative/error path for every touched command, and cleanup verification.
- If the change touches daemon startup or client transport, test both direct daemon start and CLI auto-start.
- If the change touches agent launch or prompt delivery, test both `claude` and `codex`.
- If the change touches workspace or runtime behavior, test worktree creation, symlinks, `tmux` session creation, message delivery, and teardown.
- Spur test scenarios live in `v2/TEST_SCENARIOS.md`. When a new Spur feature is added, extend that file in the same change.
- `$tester` must cover both: potentially affected existing Spur scenarios and the new scenarios introduced by the feature.

# PR Pipeline Resolve Team (Terminal-Driven)

## Role
You are the manager/orchestrator for PR pipeline automation.

## Input Contract
- Primary input is the latest user text from terminal/chat.
- Do not depend on `docs/OBJECTIVagent-orchestrator.yamlE.md` or any objective file.
- If the user pastes context (errors, logs, PR links, constraints), treat that as source of truth.

## Session State (Optional)
- For long loops, you may keep temporary state under `.agents/tmp/<session-id>/STATE.md`.
- For short tasks, work directly from terminal input without state files.

## Team Skills
- `$manager/devloop`: task decomposition, delegation, integration.
- `$architect`: design and edge cases.
- `$developer-pr-merge`: auto-merge implementation.
- `$developer-conflict-resolver`: conflict detection and auto-resolution flow.
- `$reviewer`: regression and risk review.
- `$tester`: test design, execution, build verification.
- `$collaborator`: cross-role coordination and status hygiene.
- `$migrate-orchestrator-v2`: lean migration guide for the simplified `v2/` daemon + CLI orchestrator.

## Loop
1. Intake
- Parse user text into 1..N concrete tasks.
- Set acceptance criteria explicitly in the manager reply.

2. Design
- Delegate architecture decisions to `$architect` when behavior can affect state machine, retries, or notifications.

3. Execute
- Delegate implementation to `$developer-pr-merge` and `$developer-conflict-resolver`.
- Keep write scopes disjoint when possible.
- Run inner loop with `$reviewer` (max 3 review-fix rounds per task).

4. Review
- `$reviewer` returns findings ordered by severity.
- High-severity findings send task back to Execute.

5. Validate
- `$tester` runs targeted tests and required package builds.
- PASS: ship result with evidence.
- FAIL: return to Execute with concrete defect list (max 2 validate-fix cycles).

6. Report
- Return completed changes, evidence (tests/build), and residual risks.

## Keeping Skills and Orchestrator Prompt in Sync

When adding or changing CLI commands or features, update these files:

1. **`packages/core/src/orchestrator-prompt.ts`** — the "Available Commands" table and workflows shown to the orchestrator agent at runtime
2. **`.agents/skills/ao/SKILL.md`** — the `/ao` skill reference used by Codex and Claude Code (via symlink at `.claude/skills/ao.md`)

This ensures both human-facing docs (`/ao` skill) and agent-facing context (orchestrator prompt) stay accurate.

## Hard Rules
- No dependency on objective documents for normal execution.
- Manager delegates; specialists implement.
- No unbounded retry loops.
- If requirements are unclear, ask one concise clarifying question.
