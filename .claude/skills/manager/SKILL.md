---
name: manager
description: Run every repo task through a layered manager loop: intake, research, plan, implementation, simplification, review, validation, and recheck. Mandatory for every task in this repo. Don't use for Telegram notifications, PR-only follow-up, or CI-only monitoring.
---

# Manager

Coordinate work through repo agents. Delegate code changes to `developer`.

## Use this skill when

- Every task in this repo.
- Collapse phases for trivial work instead of skipping the skill.
- Use the full loop for complex, ambiguous, multi-file, or multi-step work.

## Do not use

- `ao-telegram`
- PR creation or PR updates
- CI monitoring or CI-only follow-up

## Loop

1. Intake
- Parse the latest user message into concrete tasks.
- State acceptance criteria in the first reply.
- Treat pasted logs, errors, diffs, PR links, and commands as source of truth.
- Ask at most one concise question only when a wrong assumption would change implementation.
- If the task touches `v2/`, load `migrate-orchestrator-v2`.
- If the task changes `SKILL.md`, agent definitions, or orchestrator instructions, load `ao-skill-writer`.
- If the task changes durable instructions, mirror `AGENTS.md` and `CLAUDE.md`.
- If the task changes mirrored agent or skill files, mirror `.agents/` and `.claude/`.

2. Shallow scoring
- Run `ao-shallow-scoring`.
- Score `<= 1`: skip research unless the codebase is unclear.
- Score `>= 2`: run the full loop.

3. Research
- Run `researcher` and `critic` in parallel when score `>= 2`.
- Keep one selected approach.
- Batch unresolved questions and defaults into one clarify pass.
- Skip this step only when the change is obvious from local code.

4. Clarify
- Skip when there is no ambiguity that changes the implementation.
- Ask one batched clarification round.
- Continue with stated defaults if the user accepts them or does not answer.

5. Planning
- Run `architect` for every non-trivial task.
- Require touched files, concrete steps, acceptance criteria, risks, and the cheapest validation tier that still crosses the changed boundary.
- Reject vague plans.

6. Implementation
- Run one or more `developer` agents.
- Split write scopes only when parallel work is clearly independent.
- Keep one implementation path.
- Require local self-checks before handoff.

7. Simplification review
- Run `code-simplifier`.
- This pass is mandatory when the skill exists.
- Simplifier focuses on deletions, merged paths, narrower types, and shorter instructions.
- If it requests changes, fix with `developer` and rerun it.
- Stop after 3 simplify-fix cycles. Then report `BLOCKED_SIMPLIFY`.

8. Review
- Run `reviewer`.
- Reviewer focuses on correctness, regressions, uncovered acceptance criteria, and missing validation.
- If it requests changes, fix with `developer` and rerun it.
- Stop after 3 review-fix cycles. Then report `BLOCKED_REVIEW`.

9. Design review
- UI only.
- Run `designer`.
- Stop after 2 design-fix cycles. Then report `BLOCKED_DESIGN`.

10. Validation
- Run `tester` for every code, config, CLI, workflow, or behavior change. Skip only for wording-only docs.
- Always run the relevant package `build` command(s) before completion.
- Require positive path, negative or error path, and cleanup verification at the cheapest tier that still crosses the changed boundary.
- `v2/` changes: follow `AGENTS.md` and `CLAUDE.md` tier rules, rerun impacted `v2/TEST_SCENARIOS.md` scenarios, and include `pnpm --dir v2 build`.
- Stop after 2 test-fix cycles. Then report `BLOCKED_VALIDATION`.

11. Recheck
- After any code or config fix made after step 7, rerun every downstream gate touched by that fix.
- Minimum:
  - post-simplifier fix -> rerun `code-simplifier`, `reviewer`, and `tester` when validation was required
  - post-review fix -> rerun `reviewer`, `code-simplifier`, and `tester`
  - post-tester fix -> rerun the failed check, one adjacent impacted scenario, and the relevant build
- Never report complete on stale review or stale test evidence.

12. Final audit
- Verify each acceptance criterion has evidence.
- Verify required mirrors and prompt/skill sync updates landed when applicable.
- Prepare a short activity summary for the final report:
  - activations: every skill and agent activated, with count
  - loops: every looped gate run count
  - edits: changed-file count for each implementation or fix pass
- Stop. No Telegram, no PR, no CI loop.

## Rules

- This skill is mandatory for every task in this repo.
- Keep the manager loop only here. `AGENTS.md`, `CLAUDE.md`, and agent configs must reference this skill instead of duplicating it.
- Use the smallest team that covers the task.
- Prefer one phase, one owner, one output.
- Use local checks only. Never wait for remote CI.
- No unbounded retry loops.
- Count `edits` as changed files in that pass. Keep the summary short.
- Reply only in the current thread.

## Output

```text
## Manager Run

Task:
- <task>

Acceptance criteria:
- <criterion>

Execution:
- scoring: <N>/5
- research: DONE | SKIPPED
- clarify: DONE | SKIPPED
- architect: DONE | SKIPPED
- developer: DONE
- simplifier: APPROVED | CHANGES_REQUESTED | UNAVAILABLE
- reviewer: APPROVED | CHANGES_REQUESTED
- designer: APPROVED | SKIPPED
- tester: PASS | FAIL | SKIPPED
- recheck: DONE | SKIPPED

Checks:
- <command or scenario> — OK|FAIL

Activity:
- activations: <role>x<count>, <role>x<count>
- loops: research=<count>, review=<count>, simplify=<count>, validation=<count>, recheck=<count>
- edits: impl#1=<files>, simplify-fix#1=<files>, review-fix#1=<files>, validate-fix#1=<files>

Risks:
- <risk>
```
