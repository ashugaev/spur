# CLAUDE.md — Agent Orchestrator

## What This Is

**Core principle: Push, not pull.** Spawn agents, walk away, get notified when your judgment is needed.

**Lean defaults**
- Keep instructions short and operational. Cut anything that does not change implementation.
- Think twice, write once. Do not add code, commands, docs, or instructions until the shorter version is clearly insufficient.
- Keep commands, docs, and prompts minimal. Prefer the shortest form that still preserves correctness and clarity.
- Do not ask the same question twice in one task. If clarification is still needed, ask one narrower follow-up that names the remaining decision.
- Ask the smallest precise question that changes implementation. Prefer concrete choices over broad or open-ended prompts.
- Absolute local filesystem paths in docs and comments are an antipattern. Prefer relative paths; if that is not practical, use path placeholders or `~/`-style examples instead of machine-specific paths.
- Do not write anything for the future. No speculative hooks, no placeholder branches, no config fields, no docs sections for behavior that does not exist yet.
- If code is not functional in the current product behavior, delete it instead of keeping it around for later.
- Do not keep two different ways to solve the same task. Pick one interface, one code path, and remove the alternate form.
- Prefer one implementation path per feature.
- Remove fallback paths, compatibility shims, and duplicate abstractions before adding new ones.
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
- `v2/` is `Spur`. Use `Spur` as the name of the new orchestrator in code, config, docs, and CLI surfaces.
- For Spur work, change only `v2/`. Treat `v1` and the current `ao` tree as legacy reference-only and do not wire new Spur behavior to them.
- For `v2/`, port behavior only when it reduces code. Do not port the old architecture by default.
- If a feature is not needed for the current milestone, leave it out.
- `AGENTS.md` and `CLAUDE.md` must stay in sync. If you add or change a durable instruction in one, mirror it in the other in the same change.
- Mirrored agent and skill files under `.agents/` and `.claude/` must stay in sync. If you change one copy, mirror the other in the same change.

## Spur (`v2/`)

- `Spur` is the lean `v2/` orchestrator. Treat its interface as fixed unless the user asks to change it.
- `Spur` is CLI plus local HTTP daemon. There is no UI layer in the current milestone.
- The current human-facing `Spur` command surface is: `spawn`, `list`, `send`, `pause`, `complete`, `kill`. `daemon start` stays as the internal daemon command and is hidden from `spur --help`.
- `Spur` CLI defaults to human output. Use `--json` only on commands that expose structured data for scripts.
- `Spur` brand mark is `𖤓`. Use it for CLI help headers, runtime summary lines, and spinner frames.
- `Spur list` is the only session UI: on a TTY it opens the live selector with runtime summary and selected-session details; `Enter` attaches in place, `p` pauses, `c` completes, `r` restores, `k` kills, and `Esc` quits. Non-TTY `list` prints a one-shot runtime summary plus session cards.
- `Spur list` hides `completed` and `killed` sessions by default.
- `spawn` is positional: `spur spawn <project> <prompt...>` with optional `--agent` and `--branch`.
- Workspace setup in `Spur` is only: `git worktree`, configured symlinks, detached `tmux`, then agent launch.
- Supported agents in `Spur` are only `claude` and `codex`.
- Both `Spur` agents must launch with full access by default:
  `claude --dangerously-skip-permissions` and
  `codex --dangerously-bypass-approvals-and-sandbox`.

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

## Tech Stack

TypeScript (ESM), Node 20+, pnpm workspaces. Next.js 15 (App Router) + Tailwind. Commander.js CLI + `@clack/prompts` for interactive TUI. YAML + Zod config. Server-Sent Events for real-time. Flat metadata files + JSONL event log. ESLint + Prettier. vitest.

## Architecture

8 plugin slots — every abstraction is swappable:

| Slot      | Interface   | Default Plugin |
| --------- | ----------- | -------------- |
| Runtime   | `Runtime`   | tmux           |
| Agent     | `Agent`     | claude-code    |
| Workspace | `Workspace` | worktree       |
| Tracker   | `Tracker`   | github         |
| SCM       | `SCM`       | github         |
| Notifier  | `Notifier`  | desktop        |
| Terminal  | `Terminal`  | iterm2         |
| Lifecycle | (core)      | —              |

**All interfaces defined in `packages/core/src/types.ts` — read this file first.**

## Directory Structure

```
packages/
  core/          — @composio/ao-core (types, config, services)
  cli/           — @composio/ao-cli (the `ao` command)
  web/           — @composio/ao-web (Next.js dashboard)
  plugins/
    runtime-{tmux,process}/
    agent-{claude-code,codex,aider,opencode}/
    workspace-{worktree,clone}/
    tracker-{github,linear}/
    scm-github/
    notifier-{desktop,slack,composio,webhook}/
    terminal-{iterm2,web}/
```

## Key Files (Read These First)

1. `packages/core/src/types.ts` — all interfaces (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal)
2. `agent-orchestrator.yaml.example` — config format
3. Plugin examples:
   - `packages/plugins/runtime-tmux/src/index.ts` — Runtime implementation
   - `packages/plugins/agent-claude-code/src/index.ts` — Agent implementation
4. This file (CLAUDE.md) — code conventions

## TypeScript Conventions (MUST follow)

- **ESM modules** — `"type": "module"` in all packages
- **`.js` extensions in imports** — `import { foo } from "./bar.js"` (required for ESM)
- **`node:` prefix for builtins** — `import { readFileSync } from "node:fs"`
- **Strict mode** — `"strict": true` in tsconfig
- **`type` imports** — `import type { Foo }` for type-only (enforced by ESLint)
- **No `any`** — use `unknown` + type guards (ESLint error)
- **No unsafe casts** — `as unknown as T` bypasses type safety, validate instead
- **Prefer `const`** — `let` only when reassignment needed, never `var`
- **Semicolons, double quotes, 2-space indent** — enforced by Prettier

## Shell Command Execution (MUST follow — security critical)

- **Always use `execFile`** (or `spawn`) — NEVER `exec` (shell injection risk)
- **Always add timeouts** — `{ timeout: 30_000 }` for external commands
- **Never interpolate user input** — pass as array args, not string template
- **Do NOT use `JSON.stringify` for shell escaping** — not a shell escaping function

```typescript
// GOOD
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { timeout: 30_000 });

// BAD — shell injection risk
exec(`git checkout ${branchName}`); // branchName could contain ; rm -rf /
```

## Error Handling

- Throw typed errors, don't return error codes
- Plugins throw if they can't do their job
- Core services catch and handle plugin errors
- **Always wrap `JSON.parse`** in try/catch (corrupted metadata should not crash)
- **Guard external data** — validate types from API/CLI/file inputs

## Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` (only true constants: env vars, regex patterns)
- Test files: `*.test.ts` (co-located or in `__tests__/`)

## Commands

```bash
pnpm install           # install deps
pnpm build             # build all packages
pnpm typecheck         # typecheck
pnpm lint              # ESLint check
pnpm lint:fix          # ESLint auto-fix
pnpm format            # Prettier format
pnpm format:check      # Prettier check (CI)
pnpm test              # run tests

# Before committing
pnpm lint && pnpm typecheck
```

## Development Workflow

### Running the Dev Server

**IMPORTANT**: The web dashboard depends on built packages. Always build before running dev server.

```bash
# 1. Install dependencies (first time only)
pnpm install

# 2. Build all packages (required before dev server)
pnpm build

# 3. Ensure config exists
# Copy agent-orchestrator.yaml.example to agent-orchestrator.yaml and configure
cp agent-orchestrator.yaml.example agent-orchestrator.yaml

# 4. Run the dev server
cd packages/web
pnpm dev
```

**Why build first?** The web package imports from `@composio/ao-core` and plugin packages. These must be built (TypeScript compiled to JavaScript) before Next.js can resolve them.

**Config requirement**: The app expects `agent-orchestrator.yaml` in the working directory. Without it, all API routes will fail with "No agent-orchestrator.yaml found".

### Working with Worktrees

If using git worktrees (common for parallel agent work):

```bash
# After creating a worktree
cd /path/to/worktree
pnpm install          # Install deps
pnpm build            # Build packages
cp /path/to/main/agent-orchestrator.yaml .  # Copy config
cd packages/web && pnpm dev  # Start server
```

## Using Playwright (MCP browser tool)

Before navigating with Playwright, kill any stale Chrome for Testing instance first — otherwise it fails silently with "Opening in existing browser session":

```bash
pkill -f "Google Chrome for Testing"
```

Then use `browser_navigate` as normal. If Playwright was previously used in the session it may have left an orphaned Chrome process.

## Common Mistakes to Avoid

- Using `exec` instead of `execFile` — security vulnerability
- Using `JSON.stringify` for shell escaping — does not escape `$`, backticks, `$()`
- Missing `.js` extension in local imports — runtime error with ESM
- Using bare `"fs"` instead of `"node:fs"` — inconsistent
- Casting with `as unknown as T` — bypasses type safety, crashes on bad data
- `export default plugin` without `satisfies PluginModule<T>` — loses type checking
- Interpolating user input into shell commands, AppleScript, or GraphQL queries
- Forgetting to clean up setInterval/setTimeout on disconnect/destroy
- Using `on("exit")` instead of `once("exit")` for one-time handlers

## Keeping Skills and Orchestrator Prompt in Sync

When adding or changing CLI commands or features, update these files:

1. **`packages/core/src/orchestrator-prompt.ts`** — the "Available Commands" table and workflows shown to the orchestrator agent at runtime
2. **`.agents/skills/ao/SKILL.md`** — the `/ao` skill reference used by Codex and Claude Code (via symlink at `.claude/skills/ao.md`)

This ensures both human-facing docs (`/ao` skill) and agent-facing context (orchestrator prompt) stay accurate.

## PR Pipeline Resolve Team (Terminal-Driven)

- Use `.agents/skills/manager/SKILL.md` as the only manager workflow for this repo.
- Run it for every task, including short one-shot work.
- Do not duplicate the manager loop in configs or agent files. Reference the skill instead.
- Keep `.claude/skills/manager/SKILL.md` mirrored with `.agents/skills/manager/SKILL.md`.

## Config

Config loaded from `agent-orchestrator.yaml` (see `agent-orchestrator.yaml.example`). Paths support `~` expansion. Validated with Zod at load time. Per-project overrides for plugins and reactions.

## Design Decisions

1. **Stateless orchestrator** — no database, flat metadata files + event log
2. **Plugins implement interfaces** — pure implementation of interface from `types.ts`
3. **Push notifications** — Notifier is primary human interface, not dashboard
4. **Two-tier event handling** — auto-handle routine issues, notify human when judgment needed
5. **Backwards-compatible metadata** — flat key=value files
6. **Security first** — `execFile` not `exec`, validate all external input
