AGENTS.md

Every task starts in `manager` mode unless spawn requested another, see MODES. Manager routes work via the catalogs below. Each agent and skill carries its own frontmatter `description` with triggers — read it before invoking.


MIRROR

  `AGENTS.md` and `CLAUDE.md` stay content-synced; tree-specific link paths differ between them.
  Root `LICENSE` and `NOTICE` stay byte-synced with their `v2/` copies.
  Files under `.agents/` and `.claude/` stay in sync. Change one, mirror the other in the same change.
  `.codex/agents/*.toml` are the Codex-side agent prompts, parallel to `.claude/agents/*.md`. Update them when behavior or rules change.
  `.cursor/BUGBOT.md` configures Cursor BugBot review focus. Keep aligned with ALWAYS-ON RULES below.
  Hook scripts mirror per runtime: `.claude/hooks/`, `.codex/hooks/`, `.cursor/hooks/`. Sync runtime-specific scripts across all three. Cross-runtime scripts, for example `auto-push.sh`, live only in `.claude/hooks/`, referenced from each runtime's `hooks.json`.


AGENTS

Autonomous workers invoked via the `Task` tool. Source: .agents/agents/

  researcher            .agents/agents/researcher.md            Generate 2-3 implementation options with codebase evidence
  reference-researcher  .agents/agents/reference-researcher.md  Extract reusable patterns from external reference repos
  critic                .agents/agents/critic.md                Verify researcher claims, score options, select winner
  architect             .agents/agents/architect.md             Produce an executable spec: recon findings, change map, invariants, acceptance criteria bound to verification
  spec-critic           .agents/agents/spec-critic.md           Falsify the architect's spec before the developer builds — check cited facts, change map, bound acceptance criteria
  developer             .agents/agents/developer.md             Implement, fix-after-review, fix-after-test
  reviewer              .agents/agents/reviewer.md              Static diff analysis plus build/lint/test gate
  designer              .agents/agents/designer.md              UI review for visible web changes
  design-author         .agents/agents/design-author.md         Author and export a UI design before implementation (Claude Design); drive approval; hand a runtime-neutral design-spec to any coding agent
  tester                .agents/agents/tester.md                Validation gate at the cheapest crossing tier
  curator               .agents/agents/curator.md               Maintain the task's append-only structured memory and refresh the compact handoff between gates (Tier 2/3)


SKILLS

Capabilities loaded by description match. Source: .agents/skills/

  manager             .agents/skills/manager/SKILL.md             Mandatory orchestrator for every repo task
  spur                .agents/skills/spur/SKILL.md                Task touches Spur runtime, CLI, config, or interface
  frontend-codestyle  .agents/skills/frontend-codestyle/SKILL.md  Task touches packages/web
  skill-writer        .agents/skills/skill-writer/SKILL.md        Edit SKILL.md, agent definitions, or orchestrator instructions
  context-audit       .agents/skills/context-audit/SKILL.md       Audit agent context surface: skills, rules, MCP config, tool budget
  design              .agents/skills/design/SKILL.md              Producing or exporting a design via Claude Design, or defining the design export contract
  code-simplifier     .agents/skills/code-simplifier/SKILL.md     Reduce diff overhead before review
  github              .agents/skills/github/SKILL.md              Use gh CLI for PRs, issues, checks, or releases
  shallow-scoring     .agents/skills/shallow-scoring/SKILL.md     Route a task to a deliberation tier by ambiguity × blast radius
  self-verify         .agents/skills/self-verify/SKILL.md         Final close-out gate validation
  telegram            .agents/skills/telegram/SKILL.md            Send Telegram notification or fetch updates
  pr-comments-fix     .agents/skills/pr-comments-fix/SKILL.md     Fix and resolve PR review comments
  docs                .agents/skills/docs/SKILL.md                Task touches published docs under docs/ or the root doc files
  clean-install-test  .agents/skills/clean-install-test/SKILL.md  Clean-room test the npm server install before release, or verify a source-install deploy change end to end on the itest VM
  spur-update         .agents/skills/spur-update/SKILL.md         Roll a Spur host onto a published npm version by hand when the automatic update fails


MODES

  One mode per session: a prompt suffix naming the skill that session follows. Resolved once at spawn; config shape in `docs/configuration.md` Modes. Prompt-level and advisory — anything mandatory belongs in hooks or the daemon.

  manager  .agents/skills/manager/SKILL.md  Default for every repo task


RESPONSE STYLE

  Terse like caveman. Technical substance exact. Only fluff dies.
  Word bans are the `CAVEMAN, HARD` list in `skill-writer` (.agents/skills/skill-writer/SKILL.md). Same bans apply to replies. One hit is a defect.
  Verb first. Number over adjective: "under 200 lines", never "large". Name the command, never describe it.
  Deletion test on every sentence: cut it, reread. No instruction changed, it stays cut.
  Fragments OK. Code/commits/PRs/identifiers unchanged.
  Pattern: [thing] [action] [reason]. [next step].
  Lead with the answer or result. No preamble ("Here is", "Based on", "I'll now"), no closing recap of what you did.
  No sycophancy or validation openers: never "good question", "great", "you're right", "absolutely". Answer, do not flatter.
  Reasoning is caveman too: fragments, not sentences. Note the fact and the decision, skip the narration. No reflection filler ("Wait", "Hmm", "Let me think", "Actually"), no self-address, no restating the prompt, no announcing the next step before taking it. Depth tracks difficulty: one line on simple, deep only when hard.
  Replies obey the same word bans as files. Hedge, degree, meta, justifying, transition, courtesy — all banned in prose to the user.
  Default short. Expand only on request or when correctness needs the detail.
  Off only on explicit "stop caveman" / "normal mode".


TASK MEMORY

  Read `$SPUR_SESSION_ARTIFACTS_DIR/task-memory.md` first if present — curator's handoff: task model, facts, decisions, assumptions, open questions. Re-read the repo when it falls short. Handoff, not authority — code wins.


ALWAYS-ON RULES

  Keep instructions lean. Only include constraints that materially change implementation.
  Think twice, write once. Prefer the shortest form that preserves correctness.
  Never modify code with scripts (`sed`, `awk`, codemods, `find -exec`, mass replace). Edit files one at a time, by hand, after reading the file's context.
  Do not write speculative hooks, placeholder branches, fallback flows, or future-only code. Delete code that is not part of current behavior.
  Keep one path per feature. Do not duplicate types, helpers, validation, constants, or cleanup logic.
  Apply defaults at the boundary. Fail fast in core logic. Limit fallback handling to cleanup around external tools and teardown paths.
  Do not write `catch (error) { throw error }` or other no-op wrappers.
  Prefer narrow types and explicit shapes. Use discriminated unions and validated objects, not index-signature bags. No `any` — `unknown` + type guards.
  Trust upstream-validated typed values. Do not re-validate data already validated at the boundary.
  Wrap `JSON.parse` in try/catch; validate external data before use.
  ESM imports with `.js` extension, `node:` prefix for builtins.
  `execFile`/`spawn` only, never `exec`. No user input interpolated into shell commands.
  `const` preferred, no `var`.
  Detect session state and rate limits from structured agent sources first (transcript/rollout JSONL, status files). Scan the tmux pane buffer only as a fallback when the structured sources cannot resolve it. Never start detection from tmux.
  Do not ask the same question twice in one task. Ask the smallest precise question that changes implementation.
  Absolute local filesystem paths in docs and comments are an antipattern. Use relative paths or `~/`-style placeholders.
  Before marking implementation complete, run the relevant package `build` command(s) and fix failures.
  For every code change, write or update tests at the cheapest tier that crosses the changed boundary.
  Branch names: `feature/<short-description>` (1-4 lowercase hyphen-separated words).
  Commit messages: conventional commits for semantic-release on `main`. Format: `type(scope): subject`. `fix:` patch (`0.1.1` → `0.1.2`), `feat:` minor (`0.1.1` → `0.2.0`), `feat!:` or footer `BREAKING CHANGE:` major. `chore:`, `docs:`, `refactor:`, `test:`, `ci:` do not publish a new npm version. Squash-merge PR titles use the same prefix. No `wip` on merged commits.
  Default close-out: push to the existing PR branch, or create a new PR with auto-merge enabled. Never merge with failing CI; pre-existing failures are still your responsibility to fix.
  Use `Spur` in code, config, docs, and CLI surfaces.
  Manager mode is strict. Outside `$manager`, agents can deviate from canonical gates.
  Never create new projects in, or otherwise interact with (deploy, start/stop, direct API calls), the main production Spur instance without the user's explicit instruction. Test only against local/sandbox instances (isolated-daemon, `spur-sidecar`); see `.agents/skills/spur/SKILL.md` Safety and In this repo for detail.
  Deploy for review or test with `scripts/test-deploy.sh`, never `npm install -g` by hand.
  Use the `TodoWrite` tool for task lists; never invent text-based todo formats.
  Capture what the task taught before closing it. Route by scope: reusable across projects -> global rules; specific to this repo -> the owning `SKILL.md` or `spur memory --scope project`. Skip what git history, the code, or an existing rule already records.
  Worth capturing: a protocol that worked, a tool quirk, a wrong assumption that cost a cycle, a load-bearing invariant. Not: task status, one-off trivia, anything re-derivable by reading the code.
  Skill found stale, wrong, or missing a rule while using it: fix it in the same change. Never leave a known-wrong instruction for the next agent.
  No bold markdown (`**...**`) in skills, agents, rules, `AGENTS.md`, or `CLAUDE.md`. Use plain text or colon labels.
  Skill and agent bodies follow the FORMAT law in `skill-writer` (.agents/skills/skill-writer/SKILL.md): markdown file, minimal markdown, UPPERCASE labels and two-space indent instead of headings, tables, and fences. Lists use `-`; number only when the number carries meaning.
  Never restate an external tool's help, a code constant a source file defines, or a config key a doc owns. Reference it.
  Any change to Spur config (spur.yaml/AppConfig) or the Spur agent interface (CLI commands and flags, daemon HTTP routes, source and event names, in-session tool and env contracts, config-driven behavior) must be recorded in the config docs in the same change. Canonical docs: `docs/configuration.md` (config) and `docs/commands.md` (CLI); mirror the change to both `spur` SKILL.md files, which stay byte-identical. Verify every default you state against current source in the same change; never copy one from another doc's prose. Re-review these docs for drift whenever config or interface changes.
  Document user-facing functionality (command, flag, config field, source type, provider, event, install/deploy/CLI behavior) in the same change; never ship it undocumented. Any published-doc edit loads the `docs` skill and follows it — the skill owns the doc standards (single source, granular, link don't restate).
