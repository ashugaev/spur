# AGENTS.md

Every task starts with `$manager`. Manager routes work via the catalogs below. Each agent and skill carries its own frontmatter `description` with triggers — read it before invoking.

## Mirror

- `AGENTS.md` and `CLAUDE.md` stay content-synced; tree-specific link paths differ between them.
- Files under `.agents/` and `.claude/` must stay in sync. When you change one, mirror the other in the same change.
- `.codex/agents/*.toml` are the Codex-side agent prompts (parallel to `.claude/agents/*.md`). Update them when behavior or rules change.
- `.cursor/BUGBOT.md` configures Cursor BugBot review focus. Keep aligned with `## Always-on rules`.
- Hook scripts mirror per runtime: `.claude/hooks/`, `.codex/hooks/`, `.cursor/hooks/`. Sync runtime-specific scripts across all three. Cross-runtime scripts (for example `auto-push.sh`) live only in `.claude/hooks/` and are referenced from each runtime's `hooks.json`.

## Agents

Autonomous workers invoked via the `Task` tool. Source: [.agents/agents/](.agents/agents/).

| Agent                                                            | Use when                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`researcher`](.agents/agents/researcher.md)                     | Generate 2-3 implementation options with codebase evidence                                                    |
| [`reference-researcher`](.agents/agents/reference-researcher.md) | Extract reusable patterns from external reference repos                                                       |
| [`critic`](.agents/agents/critic.md)                             | Verify researcher claims, score options, select winner                                                        |
| [`architect`](.agents/agents/architect.md)                       | Produce an executable spec: recon findings, change map, invariants, acceptance criteria bound to verification |
| [`developer`](.agents/agents/developer.md)                       | Implement, fix-after-review, fix-after-test                                                                   |
| [`reviewer`](.agents/agents/reviewer.md)                         | Static diff analysis plus build/lint/test gate                                                                |
| [`designer`](.agents/agents/designer.md)                         | UI review for visible web changes                                                                             |
| [`tester`](.agents/agents/tester.md)                             | Validation gate at the cheapest crossing tier                                                                 |
| [`curator`](.agents/agents/curator.md)                           | Maintain the task's append-only structured memory and refresh the compact handoff between gates (Tier 2/3)    |

## Skills

Capabilities loaded by description match. Source: [.agents/skills/](.agents/skills/).

| Skill                                                              | Load when                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`manager`](.agents/skills/manager/SKILL.md)                       | Mandatory orchestrator for every repo task                                    |
| [`spur`](.agents/skills/spur/SKILL.md)                             | Task touches Spur runtime, CLI, config, or interface                          |
| [`frontend-codestyle`](.agents/skills/frontend-codestyle/SKILL.md) | Task touches `packages/web`                                                   |
| [`skill-writer`](.agents/skills/skill-writer/SKILL.md)             | Edit `SKILL.md`, agent definitions, or orchestrator instructions              |
| [`code-simplifier`](.agents/skills/code-simplifier/SKILL.md)       | Reduce diff overhead before review                                            |
| [`github`](.agents/skills/github/SKILL.md)                         | Use `gh` CLI for PRs, issues, checks, or releases                             |
| [`shallow-scoring`](.agents/skills/shallow-scoring/SKILL.md)       | Route a task to a deliberation tier by ambiguity × blast radius               |
| [`self-verify`](.agents/skills/self-verify/SKILL.md)               | Final close-out gate validation                                               |
| [`telegram`](.agents/skills/telegram/SKILL.md)                     | Send Telegram notification or fetch updates                                   |
| [`pr-comments-fix`](.agents/skills/pr-comments-fix/SKILL.md)       | Fix and resolve PR review comments                                            |
| [`docs-management`](.agents/skills/docs-management/SKILL.md)       | Task touches published docs under `docs/` or the root doc files               |
| [`clean-install-test`](.agents/skills/clean-install-test/SKILL.md) | Clean-room test the npm server install on a throwaway cloud VM before release |

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
- Detect session state and rate limits from structured agent sources first (transcript/rollout JSONL, status files). Scan the tmux pane buffer only as a fallback when the structured sources cannot resolve it. Never start detection from tmux.
- Do not ask the same question twice in one task. Ask the smallest precise question that changes implementation.
- Absolute local filesystem paths in docs and comments are an antipattern. Use relative paths or `~/`-style placeholders.
- Before marking implementation complete, run the relevant package `build` command(s) and fix failures.
- For every code change, write or update tests at the cheapest tier that crosses the changed boundary.
- Branch names: `feature/<short-description>` (1-4 lowercase hyphen-separated words).
- Commit messages: conventional commits for semantic-release on `main`. Format: `type(scope): subject`. `fix:` patch (`0.1.1` → `0.1.2`), `feat:` minor (`0.1.1` → `0.2.0`), `feat!:` or footer `BREAKING CHANGE:` major. `chore:`, `docs:`, `refactor:`, `test:`, `ci:` do not publish a new npm version. Squash-merge PR titles use the same prefix. No `wip` on merged commits.
- Default close-out: push to the existing PR branch, or create a new PR with auto-merge enabled. Never merge with failing CI; pre-existing failures are still your responsibility to fix.
- Use `Spur` in code, config, docs, and CLI surfaces.
- Manager mode is strict. Outside `$manager`, agents may deviate from canonical gates.
- Never create new projects in, or otherwise interact with (deploy, start/stop, direct API calls), the main production Spur instance without the user's explicit instruction. Test only against local/sandbox instances (isolated-daemon, `spur-sidecar`); see `.agents/skills/spur/SKILL.md` Agent Isolation for detail.
- Use the `TodoWrite` tool for task lists; never invent text-based todo formats.
- No bold markdown (`**...**`) in skills, agents, rules, `AGENTS.md`, or `CLAUDE.md`. Use plain text, colon labels, or table cells.
- Any change to Spur config (spur.yaml/AppConfig) or the Spur agent interface (CLI, API, config-driven behavior) must be recorded in the config docs in the same change. Canonical config doc: README.md `## Config`; mirror the change to both `spur` SKILL.md files. Re-review these docs for drift whenever config or interface changes.
- Document user-facing functionality (command, flag, config field, source type, provider, event, install/deploy/CLI behavior) in the same change; never ship it undocumented. Any published-doc edit loads the `docs-management` skill and follows it — the skill owns the doc standards (single source, granular, link don't restate).
