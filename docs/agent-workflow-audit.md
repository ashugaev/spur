# Agent Workflow Audit

Date: 2026-04-18
Scope: repo agent rules, workflow prompts, mirrored skill/agent files

## What was reviewed

- `AGENTS.md`
- `CLAUDE.md`
- `.agents/agents/*.md`
- `.agents/skills/*/SKILL.md`
- mirrored `.claude/` copies
- `v2/README.md`
- `v2/TEST_SCENARIOS.md`

## Highest-priority findings

### P0. `manager` requires an impossible dependency order

- `manager` says to run `researcher` and `critic` in parallel: `.agents/skills/manager/SKILL.md:45-49`
- `critic` is explicitly defined as a step after `researcher`, and its first job is to verify the researcher's claims: `.agents/skills/critic/SKILL.md:1-18`, `.agents/agents/critic.md:1-18`

Impact:
- The workflow cannot be followed literally.
- A strict implementation either gives `critic` stale input or fakes the dependency.
- This directly reduces autonomy because the agent must improvise around the workflow instead of following it.

### P0. Core agent instructions hard-code a non-existent git base

- `architect` requires `git log origin/dev --oneline -10`: `.agents/agents/architect.md:20-24`
- `reviewer` requires `git diff origin/dev...HEAD`: `.agents/agents/reviewer.md:10-15`
- This repo does not have `origin/dev`; the remote default branch is `origin/main`.

Impact:
- The default architect and reviewer commands fail before doing useful work.
- This forces hidden assumptions about branch topology.
- It also teaches the agent the wrong merge base and can corrupt review scope.

### P0. The declared Spur source of truth is internally inconsistent

- `AGENTS.md` says `v2/` is the source of truth for Spur behavior: `AGENTS.md:31-35`
- The same file says the current human-facing surface is only `spawn`, `list`, `send`, `pause`, `complete`, `kill`, and that `spawn` only has optional `--agent` and `--branch`: `AGENTS.md:41-49`
- Actual Spur docs and CLI expose more than that:
  - `service` is a user-facing command: `v2/README.md:13`
  - `spawn` supports `[prompt...]`, `--plan`, repeatable `--step`, `--worktree`, and `--shared`: `v2/README.md:15-27`, `v2/src/cli.ts:1294-1308`
  - shared sessions are real behavior: `v2/src/cli.ts:647`, `v2/TEST_SCENARIOS.md:112-117`
- `spur` and `migrate-orchestrator-v2` also describe a different surface than `AGENTS.md`: `.agents/skills/spur/SKILL.md:19-35`, `.agents/skills/migrate-orchestrator-v2/SKILL.md:19-23`

Impact:
- The agent receives conflicting instructions about the same CLI.
- This increases assumption errors on the most important product surface.
- It undermines the explicit rule that `v2/` is the source of truth.

### P0. Mirror and self-consistency guarantees are already broken

- `AGENTS.md` and `CLAUDE.md` require mirrored agent/skill files to stay in sync: `AGENTS.md:36-37`
- `.agents/skills/telegram/SKILL.md` and `.claude/skills/telegram/SKILL.md` already differ in script paths:
  - `.agents/skills/telegram/SKILL.md:18-54`
  - `.claude/skills/telegram/SKILL.md:18-54`
- `skill-writer` says a skill frontmatter name must match its directory name: `.agents/skills/skill-writer/SKILL.md:51-57`
- The same file is named `ao-skill-writer` inside directory `skill-writer`: `.agents/skills/skill-writer/SKILL.md:1-4`
- `skill-writer` forbids `You are a senior...` openings and `## Your Role` restatements for agent definitions: `.agents/skills/skill-writer/SKILL.md:79-86`, `.agents/skills/skill-writer/SKILL.md:102-113`
- `architect` still uses both anti-patterns: `.agents/agents/architect.md:8-16`
- `skill-writer` says valid agent models are `inherit | opus | sonnet`: `.agents/skills/skill-writer/SKILL.md:70-76`
- `designer` and `researcher` use `model: sonet`: `.agents/agents/designer.md:1-5`, `.agents/agents/researcher.md:1-5`

Impact:
- The workflow asks the agent to trust invariants that are already false.
- The content-authoring standard is not applied to the content itself.
- This makes prompt drift invisible until runtime.

## High-priority overheads

### P1. The full manager loop is over-mandated and contradicts its own minimal-team rule

- `manager` says score `>= 2` should run the full loop: `.agents/skills/manager/SKILL.md:33-36`
- The same skill also says to use the smallest team that covers the task: `.agents/skills/manager/SKILL.md:120-123`
- The output template hard-codes implementation-stage fields even for non-implementation work: `.agents/skills/manager/SKILL.md:129-164`
- `self-verify` refuses PASS without an open PR for repo work: `.agents/skills/self-verify/SKILL.md:12-38`

Impact:
- Analysis, audit, and docs tasks are pushed toward unnecessary developer/reviewer/tester/PR work.
- The workflow optimizes for ritual completion, not task-shape fit.
- This increases cost and encourages fake compliance.

### P1. `code-simplifier` and `reviewer` duplicate a large part of the same gate

- `code-simplifier` inspects duplicate paths, speculative hooks, extra config, repeated defaults, and asks whether the solution can be deleted, merged, narrowed, or shortened: `.agents/skills/code-simplifier/SKILL.md:12-32`
- `reviewer` already checks for overheads, dead code, duplicate logic, and whether the change can be simpler: `.agents/agents/reviewer.md:23-31`
- `manager` makes simplifier mandatory and then runs reviewer separately: `.agents/skills/manager/SKILL.md:67-78`

Impact:
- Two different gates ask overlapping questions with separate retry loops.
- The extra loop can add delay without adding much new information.

### P1. Validation guidance is not aligned across layers

- `AGENTS.md` requires package-specific builds, sidecar-only UI testing, Chrome-based manual UI checks, and Playwright on the isolated UI sidecar for visible web changes: `AGENTS.md:55-89`
- `tester` does not mention Sidecar, Chrome automation, or the isolated UI sidecar, and instead says to run UI on the branch and reuse any existing server: `.agents/agents/tester.md:17-23`, `.agents/agents/tester.md:33-39`
- `developer` and `reviewer` both use root `pnpm typecheck && pnpm lint && pnpm test` flows and omit required build steps: `.agents/agents/developer.md:18-39`, `.agents/agents/reviewer.md:10-15`

Impact:
- Different layers permit different validation behaviors.
- The agent can satisfy one instruction set while violating another.
- This weakens precision and slows root-cause analysis.

### P1. Prompt duplication is causing drift instead of reliability

- There are both agent definitions and same-named skills for `critic`, `designer`, `developer`, and `researcher`.
- Their bodies are near-duplicates with separate drift points; for example `developer` differs by a stray trailing backtick in the agent version: `.agents/agents/developer.md:56-60`, `.agents/skills/developer/SKILL.md:54-58`

Impact:
- Duplicate prompt bodies multiply maintenance burden.
- Small prompt bugs can appear in only one copy.
- The duplication is already producing inconsistent behavior.

## Medium-priority overheads

### P2. `spur` carries too much always-on context

- `spur` includes deployment-only VM, IP, systemd, nginx, port, and deploy-command details inside the main skill: `.agents/skills/spur/SKILL.md:134-154`
- Lean defaults say instructions should stay minimal and only include constraints that materially change implementation: `AGENTS.md:8-13`
- `skill-writer` explicitly says every token must justify its cost: `.agents/skills/skill-writer/SKILL.md:13-15`

Impact:
- Many ordinary `v2/` coding tasks load deployment context they do not need.
- This spends context budget on low-frequency operational details.

### P2. Some prompts still encode unnecessary assumptions instead of discovery

- `researcher` examples point at `packages/` even though Spur lives in `v2/`: `.agents/agents/researcher.md:12-17`
- `spur` and `migrate-orchestrator-v2` still present `spawn <project> <prompt...>` rather than the optional `[prompt...]` form that actual docs and CLI support: `.agents/skills/spur/SKILL.md:21-22`, `.agents/skills/migrate-orchestrator-v2/SKILL.md:21`, `v2/README.md:15-27`

Impact:
- The agent learns brittle examples instead of discovering the current interface from the codebase.
- Empty-prompt spawn is a real workflow path, so this is not cosmetic.

## Root causes

1. There is no single executable source for agent instructions.
2. Mirror rules exist, but there is no lint or generation step enforcing them.
3. Workflow gates are specified as a universal pipeline instead of a task-class router.
4. Several prompts are optimized for thoroughness theater rather than dependency-correct execution.
5. Validation rules are split across too many layers and drift independently.

## Science-backed improvement directions

### 1. Add an evidence contract before critique or finalization

Recommended change:
- Require every non-trivial phase to output `claim -> evidence`.
- For load-bearing claims, add a lightweight verify step before final answer or approval.
- Escalate to clarify only when evidence is missing and the missing fact changes implementation.

Why:
- This directly targets assumption-heavy behavior.
- It makes "I checked" auditable instead of stylistic.

Research basis:
- ReAct shows that interleaving reasoning with actions lets the model gather external information instead of relying on internal guesses.
- Chain-of-Verification shows a practical pattern: draft, write verification questions, answer them independently, then produce a final verified response.

### 2. Make deliberation conditional, not universal

Recommended change:
- Replace "score >= 2 -> full loop" with task classes:
  - question or audit
  - docs-only
  - small local code change
  - risky or cross-boundary code change
  - UI change
  - `v2` runtime change
- Make `architect`, `critic`, `code-simplifier`, `reviewer`, `designer`, and `tester` conditional on task class and uncertainty.
- Keep `research -> critic` sequential; do not parallelize dependent stages.

Why:
- This keeps planning where it pays off and removes ritual from cheap tasks.
- It aligns the workflow with actual task risk.

Research basis:
- Plan-and-Solve improves multi-step reasoning by explicitly separating planning from solving, which is useful when missing-step errors matter.
- Reflexion-style uncertainty-triggered deliberation suggests deeper deliberation should activate when uncertainty is high, not on every task.

### 3. Replace prompt mirroring with one canonical spec plus generated outputs

Recommended change:
- Keep one canonical prompt source per role or skill.
- Generate mirrored `.agents/` and `.claude/` outputs from that source.
- Add a repo lint that fails on:
  - mirror drift
  - invalid frontmatter names
  - invalid model enums
  - hard-coded branch names that do not exist
  - references to CLI flags not present in `v2/src/cli.ts`

Why:
- The repo already demonstrates that manual mirror discipline is insufficient.
- Canonical generation is lower-cost than repeated manual synchronization.

### 4. Move from static assumptions to runtime discovery

Recommended change:
- Replace hard-coded `origin/dev` with merge-base discovery or remote default branch discovery.
- For Spur CLI facts, derive prompt snippets from `v2` help text, command definitions, or a tiny checked-in generated snapshot.
- For web validation, put Sidecar and browser requirements directly in the tester prompt or a shared validation source.

Why:
- Environment assumptions are the main reason the current workflow cannot be followed literally.
- Discovery reduces silent drift.

Research basis:
- SWE-agent shows that agent-computer interface design strongly affects autonomous software performance, especially around repository navigation, editing, and test execution.

### 5. Add short failure memory, but only after real failures

Recommended change:
- After a failed review, test, or workflow step, store one tiny structured note:
  - failed assumption
  - observed evidence
  - corrected rule
- Feed only recent relevant failure notes into the next attempt.

Why:
- This improves autonomy without bloating every prompt.
- It gives the agent a concrete mechanism for learning from repo-specific mistakes.

Research basis:
- Reflexion-style episodic verbal feedback improves subsequent decisions by preserving compact lessons from prior failed attempts.

### 6. Strengthen semantic validation, not only "tests passed"

Recommended change:
- For code changes, keep the current positive/negative/cleanup policy but add one adjacent scenario replay when the failure mode is semantic.
- For workflow and prompt changes, add dedicated lint and consistency checks instead of treating them like normal docs.
- Do not treat passing tests as sufficient proof when the change affects behavioral contracts.

Why:
- Current instruction files are behavior, not just prose.
- Test-only pass signals can overstate correctness.

Research basis:
- SWE-Bench established a realistic execution-based benchmark for real GitHub issues.
- SWE-ABS shows that even top-agent success rates on test-based evaluation are inflated; roughly one in five previously "solved" patches from top agents were semantically wrong under stronger adversarial tests.

## Recommended order of attack

1. Fix the dependency and source-of-truth bugs first.
   - `research -> critic`
   - remove `origin/dev`
   - align `AGENTS.md` and `CLAUDE.md` with actual Spur surface
2. Add an agent-workflow lint before editing prompt text.
   - mirrors
   - frontmatter
   - model enums
   - CLI-surface drift
3. Introduce task-class routing in `manager`.
   - docs or audit path
   - code-change path
   - UI path
   - `v2` runtime path
4. Collapse overlapping gates.
   - either merge simplifier into reviewer, or only run simplifier on large or risky diffs
5. Add evidence and failure-memory mechanics.
   - `claim -> evidence`
   - tiny failure notes only after failed runs

## Bottom line

The biggest problem is not lack of instructions.
The biggest problem is that the instructions are duplicated, partially stale, and sometimes impossible to execute literally.

The highest-leverage improvements are:

- one canonical instruction source
- dependency-correct workflow routing
- evidence-before-finalization
- runtime discovery instead of hard-coded assumptions
- failure-triggered memory instead of always-on prompt bulk
