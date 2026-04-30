# AGENTS.md

Every task starts with `$manager`. Manager routes work via the catalogs below. Each agent and skill carries its own frontmatter `description` with triggers — read it before invoking.

## Mirror

- `AGENTS.md` and `CLAUDE.md` stay content-synced; tree-specific link paths differ between them.
- Files under `.agents/` and `.claude/` must stay in sync. When you change one, mirror the other in the same change.
- `.codex/agents/*.toml` are the Codex-side agent prompts (parallel to `.claude/agents/*.md`). Update them when behavior or rules change.
- `.cursor/BUGBOT.md` configures Cursor BugBot review focus. Keep aligned with `## Always-on rules`.
- Hook scripts mirror per runtime: `.claude/hooks/`, `.codex/hooks/`, `.cursor/hooks/`. Sync changes across all three.

## Agents

Autonomous workers invoked via the `Task` tool. Source: [.agents/agents/](.agents/agents/).

| Agent | Use when |
|---|---|
| [`researcher`](.agents/agents/researcher.md) | Generate 2-3 implementation options with codebase evidence |
| [`critic`](.agents/agents/critic.md) | Verify researcher claims, score options, select winner |
| [`architect`](.agents/agents/architect.md) | Produce a concrete plan: touched files, steps, criteria, risks |
| [`developer`](.agents/agents/developer.md) | Implement, fix-after-review, fix-after-test |
| [`reviewer`](.agents/agents/reviewer.md) | Static diff analysis plus build/lint/test gate |
| [`designer`](.agents/agents/designer.md) | UI review for visible web changes |
| [`tester`](.agents/agents/tester.md) | Validation gate at the cheapest crossing tier |

## Skills

Capabilities loaded by description match. Source: [.agents/skills/](.agents/skills/).

| Skill | Load when |
|---|---|
| [`manager`](.agents/skills/manager/SKILL.md) | Mandatory orchestrator for every repo task |
| [`spur`](.agents/skills/spur/SKILL.md) | Task touches Spur runtime, CLI, config, or interface |
| [`frontend-codestyle`](.agents/skills/frontend-codestyle/SKILL.md) | Task touches `packages/web` |
| [`skill-writer`](.agents/skills/skill-writer/SKILL.md) | Edit `SKILL.md`, agent definitions, or orchestrator instructions |
| [`code-simplifier`](.agents/skills/code-simplifier/SKILL.md) | Reduce diff overhead before review |
| [`github`](.agents/skills/github/SKILL.md) | Use `gh` CLI for PRs, issues, checks, or releases |
| [`shallow-scoring`](.agents/skills/shallow-scoring/SKILL.md) | Score task complexity 1-5 |
| [`self-verify`](.agents/skills/self-verify/SKILL.md) | Final close-out gate validation |
| [`telegram`](.agents/skills/telegram/SKILL.md) | Send Telegram notification or fetch updates |

## Response style

- Terse like caveman. Technical substance exact. Only fluff dies.
- Drop articles, filler (just/really/basically), pleasantries, hedging.
- Fragments OK. Code/commits/PRs/identifiers unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Off only on explicit "stop caveman" / "normal mode".

## Always-on rules

- Keep instructions lean. Only include constraints that materially change implementation.
- Think twice, write once. Prefer the shortest form that preserves correctness.
- Never modify code with scripts (`sed`, `awk`, codemods, `find -exec`, mass replace). Edit files one at a time, by hand, after reading the file's context.
- Do not write speculative hooks, placeholder branches, fallback flows, or future-only code. Delete code that is not part of current behavior.
- Keep one path per feature. Do not duplicate types, helpers, validation, constants, or cleanup logic.
- Apply defaults at the boundary. Fail fast in core logic. Limit fallback handling to cleanup around external tools and teardown paths.
- Do not write `catch (error) { throw error }` or other no-op wrappers.
- Prefer narrow types and explicit shapes. Use discriminated unions and validated objects, not index-signature bags.
- Trust upstream-validated typed values. Do not re-validate data already validated at the boundary.
- Do not ask the same question twice in one task. Ask the smallest precise question that changes implementation.
- Absolute local filesystem paths in docs and comments are an antipattern. Use relative paths or `~/`-style placeholders.
- Before marking implementation complete, run the relevant package `build` command(s) and fix failures.
- For every code change, write or update tests at the cheapest tier that crosses the changed boundary.
- Branch names: `feature/<short-description>` (1-4 lowercase hyphen-separated words).
- Default close-out: push to the existing PR branch, or create a new PR with auto-merge enabled. Never merge with failing CI; pre-existing failures are still your responsibility to fix.
- Use `Spur` in code, config, docs, and CLI surfaces.
