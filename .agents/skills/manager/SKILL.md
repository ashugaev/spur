---
name: manager
description: "Run every repo task through a layered manager loop: intake, research, plan, implementation, simplification, review, validation, recheck, and close-out. Mandatory for every task in this repo. Don't use for Telegram notifications or CI-only monitoring."
---

# Manager

Coordinate work through repo agents. Delegate code changes to `developer`.

## Use this skill when

- Every task in this repo.
- Collapse phases for trivial work instead of skipping the skill.
- Use the full loop for complex, ambiguous, multi-file, or multi-step work.

## Do not use

- `ao-telegram`
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

3. Granular checklist
- Build a run-specific checklist from applicable manager steps.
- Mark each checklist item `required` or `skipped` with reason.
- Define expected evidence for each `required` item.
- Execute the run against this checklist and update item status as steps complete.
- For every code-change task, always include a `write/update tests` item as a required checklist step. Never mark implementation complete without it.

4. Research
- Run `researcher` and `critic` in parallel when score `>= 2`.
- Keep one selected approach.
- Batch unresolved questions and defaults into one clarify pass.
- Skip this step only when the change is obvious from local code.

5. Clarify
- Skip when there is no ambiguity that changes the implementation.
- Ask one batched clarification round.
- Continue with stated defaults if the user accepts them or does not answer.

6. Planning
- Run `architect` for every non-trivial task.
- Require touched files, concrete steps, acceptance criteria, risks, and the cheapest validation tier that still crosses the changed boundary.
- Reject vague plans.

7. Implementation
- Run one or more `developer` agents.
- Split write scopes only when parallel work is clearly independent.
- Keep one implementation path.
- Require local self-checks before handoff.

8. Simplification review
- Run `code-simplifier`.
- This pass is mandatory when the skill exists.
- Simplifier focuses on deletions, merged paths, narrower types, and shorter instructions.
- If it requests changes, fix with `developer` and rerun it.
- Stop after 3 simplify-fix cycles. Then report `BLOCKED_SIMPLIFY`.

9. Review
- Run `reviewer`.
- Reviewer focuses on correctness, regressions, uncovered acceptance criteria, and missing validation.
- If it requests changes, fix with `developer` and rerun it.
- Stop after 3 review-fix cycles. Then report `BLOCKED_REVIEW`.

10. Design review
- UI only.
- Run `designer`.
- Stop after 2 design-fix cycles. Then report `BLOCKED_DESIGN`.

11. Validation
- Run `tester` for every code, config, CLI, workflow, or behavior change. Skip only for wording-only docs.
- Always run the relevant package `build` command(s) before completion.
- Require positive path, negative or error path, and cleanup verification at the cheapest tier that still crosses the changed boundary.
- `v2/` changes: follow `AGENTS.md` and `CLAUDE.md` tier rules, rerun impacted `v2/TEST_SCENARIOS.md` scenarios, and include `pnpm --dir v2 build`.
- Stop after 2 test-fix cycles. Then report `BLOCKED_VALIDATION`.

12. Recheck
- After any code or config fix made after step 8, rerun every downstream gate touched by that fix.
- Minimum:
  - post-simplifier fix -> rerun `code-simplifier`, `reviewer`, and `tester` when validation was required
  - post-review fix -> rerun `reviewer`, `code-simplifier`, and `tester`
  - post-tester fix -> rerun the failed check, one adjacent impacted scenario, and the relevant build
- Never report complete on stale review or stale test evidence.

13. Self evaluation
- Verify every `required` checklist item is complete with fresh evidence.
- If any `required` item is missing or stale, return to the missing step and rerun required downstream gates.

14. Final audit
- Require `self evaluation = PASS` before close-out.
- Verify each acceptance criterion has evidence.
- Verify required mirrors and prompt/skill sync updates landed when applicable.
- Default close-out unless the user opts out:
  - if the current branch already has an open PR, commit and push every update to that branch
  - if no PR exists, create one after local validation
  - enable auto-merge on new PRs when repository settings allow it
- Prepare a short activity summary for the final report:
  - activations: every skill and agent activated, with count
  - loops: every looped gate run count
  - edits: changed-file count for each implementation or fix pass
- Stop. No Telegram or CI loop.

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
- checklist: DONE | BLOCKED
- research: DONE | SKIPPED
- clarify: DONE | SKIPPED
- architect: DONE | SKIPPED
- developer: DONE
- simplifier: APPROVED | CHANGES_REQUESTED | UNAVAILABLE
- reviewer: APPROVED | CHANGES_REQUESTED
- designer: APPROVED | SKIPPED
- tester: PASS | FAIL | SKIPPED
- recheck: DONE | SKIPPED
- self-evaluation: PASS | FAIL

Checks:
- <command or scenario> — OK|FAIL

Activity:
- activations: <role>x<count>, <role>x<count>
- loops: research=<count>, review=<count>, simplify=<count>, validation=<count>, recheck=<count>
- edits: impl#1=<files>, simplify-fix#1=<files>, review-fix#1=<files>, validate-fix#1=<files>

Risks:
- <risk>
```
