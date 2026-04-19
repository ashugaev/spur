# Local Reminders

- Before marking any implementation complete, always run the relevant package `build` command(s) and fix any failures.
- For every code change, always include a separate checklist item to write or update tests for the touched code. Tests must exist at the cheapest tier that still crosses the changed boundary.

## Lean Defaults

- Keep instructions lean: include only constraints that materially change implementation.
- Think twice, write once. Do not add code, commands, docs, or instructions until the shorter version is clearly insufficient.
- Keep commands, docs, and prompts minimal. Prefer the shortest form that still preserves correctness and clarity.
- Do not ask the same question twice in one task. If clarification is still needed, ask one narrower follow-up that names the remaining decision.
- Ask the smallest precise question that changes implementation. Prefer concrete choices over broad or open-ended prompts.
- Absolute local filesystem paths in docs and comments are an antipattern. Prefer relative paths; if that is not practical, use path placeholders or `~/`-style examples instead of machine-specific paths.
- Do not write anything for the future. No speculative hooks, no placeholder branches, no config fields, no docs sections for behavior that does not exist yet.
- If code is not functional in the current product behavior, delete it instead of keeping it around for later.
- Do not keep two different ways to solve the same task. Pick one interface, one code path, and remove the alternate form.
- Prefer one clear path per feature. Avoid parallel abstractions, compatibility shims, and fallback flows unless they are required for correctness right now.
- Do not duplicate type definitions, helper functions, or validation logic. Define once, import everywhere.
- Do not re-validate data that was already validated upstream. If a function receives a typed value, trust it.
- Do not write `catch (error) { throw error; }` or other no-op wrappers. If the catch does nothing, remove it.
- Do not repeat the same cleanup/teardown sequence inline. Extract a named helper when the same steps appear in 3+ places.
- Identical constants (regexes, thresholds, magic strings) must be one binding, not separate copies.
- Prefer narrow types and explicit config shapes. In TypeScript, use discriminated unions and validated objects instead of index-signature bags.
- In Spur, avoid TypeScript overhead. Prefer the smallest type shape that preserves safety; balance and concision beat type-level cleverness.
- Apply defaults once at the boundary. Do not scatter re-defaulting and fallback branches through the runtime path.
- In core logic, fail fast instead of adding fallback behavior. Limit fallback handling to cleanup around external tools and teardown paths.
- Start every task with `$manager`. No direct-execution bypass; collapse phases inside the skill when the task is small.
- Default close-out for repo work: if the current branch already has an open PR, commit and push every update to that branch. If no PR exists, create one unless the user explicitly says not to. New PRs default to auto-merge when allowed by repository settings.
- Never merge a PR while any required CI check is failing. If checks were already failing on `main` before your branch (pre-existing failures), fix them in your PR before merging. A failing check is always your responsibility to fix regardless of who introduced it.
- Branch names for this repo must use `feature/<short-description>`, where `<short-description>` is 1-4 lowercase hyphen-separated words derived from the task.
- `v2/` is `Spur`. Use `Spur` as the name of the new orchestrator in code, config, docs, and CLI surfaces.
- `v2/` is the source of truth for Spur behavior.
- Outside `v2/`, the only supported product surface is `packages/web`, and it must remain a thin UI over Spur's daemon HTTP API.
- Remove `ao`/`v1` root artifacts instead of keeping parallel docs, configs, workflows, or package trees.
- For `v2/` migration planning or implementation, use `$migrate-orchestrator-v2`.
- `AGENTS.md` and `CLAUDE.md` must stay in sync. If you add or change a durable instruction in one, mirror it in the other in the same change.
- Mirrored agent and skill files under `.agents/` and `.claude/` must stay in sync. If you change one copy, mirror the other in the same change.

## Spur (`v2/`)

- `Spur` is the lean `v2/` orchestrator. Treat its interface as fixed unless the user asks to change it.
- `Spur` is CLI plus local HTTP daemon. `packages/web` is the only supported non-`v2` UI layer, and it must not grow its own backend or runtime logic.
- The current human-facing `Spur` command surface is: `spawn`, `list`, `send`, `pause`, `complete`, `kill`. `daemon start` stays as the internal daemon command and is hidden from `spur --help`.
- `Spur` CLI defaults to human output. Use `--json` only on commands that expose structured data for scripts.
- `Spur` brand mark is `𖤓`. Use it for CLI help headers, runtime summary lines, and spinner frames.
- `Spur list` is the only session UI: on a TTY it opens the live selector with runtime summary and selected-session details; `Enter` attaches in place, `p` pauses, `c` completes, `r` restores, `k` kills, and `Esc` quits. Non-TTY `list` prints a one-shot runtime summary plus session cards.
- `Spur list` hides `completed` and `killed` sessions by default.
- `spawn` is positional: `spur spawn <project> [prompt...]` with optional `--agent` and `--branch`. Empty prompt opens a blank session and skips default pipeline steps / initial message injection.
- Workspace setup in `Spur` is only: `git worktree`, configured symlinks, detached `tmux`, then agent launch.
- Supported agents in `Spur` are only `claude` and `codex`.
- Both `Spur` agents must launch with full access by default:
  `claude --dangerously-skip-permissions` and
  `codex --dangerously-bypass-approvals-and-sandbox`.

## Agent Isolation

- The `spur` CLI in your PATH targets your isolated instance, not production. Use it as-is.
- Port 4310 is the production daemon. Never target it with `spur daemon start`, `kill`, or direct HTTP calls.
- Do not override `--config` to point at `~/.spur/config.yaml` (root config).
- Do not kill processes or ports you did not start. Your session tool dir is in `$SPUR_SESSION_TOOL_DIR`.
- For `packages/web` work and local testing in this repo, use Sidecar only. Start it with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>` and prefer the project `sidecars` config (for example `dev`). Do not rely on `spur-sidecar` being in `PATH`; use the helper from `$SPUR_SESSION_TOOL_DIR`. `autoStart` applies only when the main session spawns; from inside a sidecar, nested sidecars are manual-only and stop after one more level.
- Do not start app, dev server, or test helper processes directly with `pnpm`, `next`, or similar commands unless the user explicitly tells you to bypass Sidecar.

## Spur Validation

- Always run `pnpm --dir v2 build` after changing Spur code.
- Spur has three test tiers:
  `fast` = `pnpm --dir v2 test` for mocked and in-process coverage. This is the default root `pnpm test` path and must stay fast.
  `runtime integration` = `pnpm --dir v2 test:runtime` for the built CLI, daemon, `git`, worktree, `tmux`, and process boundaries with fake `claude`, `codex`, and `gh`.
  `real-agent smoke` = `pnpm --dir v2 test:smoke` for narrow real `claude` and `codex` spawn/send checks on the real `ao` repo. It auto-skips when `tmux`, binaries, or agent auth are missing.
- Run `fast` for every Spur code change.
- Run `runtime integration` when the change touches CLI, daemon startup, client transport, session lifecycle, worktree setup, `tmux`, or automation runtime boundaries.
- Run `real-agent smoke` when the change touches agent launch or prompt delivery. Cover both `claude` and `codex`.
- Keep queueing, dedupe, and validation logic in `fast`; keep source, process, and `tmux` boundaries in `runtime integration`.
- Minimum Spur validation is: positive path for every touched command, negative or error path for every touched command, and cleanup verification at the cheapest tier that still crosses the changed boundary.
- If the change touches daemon startup or client transport, `runtime integration` must cover both direct daemon start and CLI auto-start.
- If the change touches workspace or runtime behavior, `runtime integration` must cover worktree creation, symlinks, `tmux` session creation, message delivery, and teardown.
- If only `v2/` changed, `$tester` must run the required tiers, exercise the touched `spur` CLI commands through positive and negative paths, rerun the impacted scenarios from `v2/TEST_SCENARIOS.md`, and run impacted `real-agent smoke` scenarios through `pnpm --dir v2 test:smoke` on the real `ao` repo with real `claude` and `codex`.
- For touched `v2/` code, `$tester` also checks for hanging logic, stray fallbacks outside boundary/cleanup paths, and loose or bloated type shapes.
- Spur test scenarios live in `v2/TEST_SCENARIOS.md`. Each scenario belongs to exactly one tier. When a new Spur feature is added, extend that file in the same change.
- `$tester` must cover both: potentially affected existing Spur scenarios and the new scenarios introduced by the feature.

## Web UI (`packages/web`)

- Every `packages/web` change must update `packages/web/UI_TEST_SCENARIOS.md` in the same commit when the change adds, removes, or alters visible behavior.
- Every `packages/web` change requires a manual browser test by the agent (via Chrome automation tools) before marking the task complete. Run the dev server, navigate to `localhost`, and verify the touched scenarios visually.
- Load `$frontend-codestyle` when implementing or reviewing `packages/web` changes.
- `pnpm --dir packages/web build` and `pnpm --dir packages/web test` must pass before completion.
- Every `packages/web` change that adds or alters visible behavior must include a Playwright E2E step in the task checklist: write or update tests in `packages/web/tests/`, then run `pnpm --dir packages/web exec playwright test` on the isolated-ui sidecar. All tests must pass before completion. Use the official Playwright MCP agent (`$playwright-test-generator`) when generating new tests.
- Color literals (hex, `rgb`, `rgba`, `hsl`, Tailwind `*-white/N`, `*-black/N`, `*-red-*`, `*-zinc-*`, etc.) are only allowed in `packages/web/src/app/globals.css` inside `@theme { ... }` and in `packages/web/src/design/colors.ts`. Every component, stylesheet, and metadata file must reference the palette via `var(--color-*)` (for CSS/Tailwind) or by importing from `@/design/colors` (for TS that cannot use CSS vars: Next.js metadata, xterm `ITheme`, tests that guard palette values). Adding a new color means adding a `--color-*` token in `globals.css` first.

## PR Pipeline Resolve Team (Terminal-Driven)

- Use `.agents/skills/manager/SKILL.md` as the only manager workflow for this repo.
- Run it for every task, including short one-shot work.
- Do not duplicate the manager loop in configs or agent files. Reference the skill instead.
- Keep `.claude/skills/manager/SKILL.md` mirrored with `.agents/skills/manager/SKILL.md`.
