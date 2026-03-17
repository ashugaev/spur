---
name: manager
description: Lean manager loop based on `.ao-agent-rules.md`. Default for complex or multi-step tasks that need planning, implementation, review, and validation. Do not use for Telegram notifications, PR creation, or CI follow-up.
---

# Manager

## Role

Coordinate work through subagents. Delegate code changes to `developer`.

## Use this skill when

- The task is complex, ambiguous, multi-file, or multi-step.
- Default to this skill for complex tasks unless the user clearly wants direct one-shot work.
- The user wants orchestrated development instead of direct coding.
- The task needs planning, implementation, review, and validation by separate roles.
- The work should stop at local completion and report.

## Do not use

- `ao-telegram`
- PR creation or PR updates
- CI monitoring or CI-only follow-up

## Loop

1. Intake
- Parse the latest user message into concrete tasks.
- State acceptance criteria in the first reply.
- If blocked on missing requirements, ask one concise question.

2. Shallow scoring
- Run `ao-shallow-scoring`.

3. Research
- Skip when score `<= 1`.
- Otherwise run `researcher` and `critic` in parallel.
- Keep one selected approach.

4. Planning
- Run `architect`.
- Require concrete steps, acceptance criteria, and risks.

5. Implementation
- Run one or more `developer` agents.
- Split write scopes when parallel.
- Keep one implementation path.

6. Review
- Run `reviewer`.
- Reviewer focuses on correctness, regressions, and missing validation.

7. Simplification review
- Run `code-simplifier`.
- This step can run in parallel with `reviewer`.
- Simplifier focuses on deletions, collapsed paths, narrower shapes, and smaller interfaces.
- If either `reviewer` or `code-simplifier` requests changes, fix with `developer` and re-run the affected pass.
- Stop after 3 review/simplify cycles.

8. Design review
- UI only.
- Run `designer`.
- Stop after 2 design-fix cycles.

9. Validation
- Run `tester` when behavior changed or packages were touched.
- UI changes: browser flow and console check.
- `v2/` changes: targeted tests, builds, touched CLI command checks, impacted `v2/TEST_SCENARIOS.md` scenarios, lean V2 check.
- Stop after 2 test-fix cycles.

10. Report
- Return scope, checks, and residual risks.
- Stop. No Telegram, no PR, no CI loop.

## Rules

- Default to this skill for complex tasks.
- Use the smallest team that covers the task.
- Prefer one phase, one owner, one output.
- Do not keep optional phases when the task does not need them.
- Use local checks only. Never wait for remote CI.
- Reply only in the current thread.

## Output

```text
## Manager Run

Task:
- <task>

Acceptance criteria:
- <criterion>

Execution:
- scoring: DONE
- research: DONE | SKIPPED
- architect: DONE
- developer: DONE
- reviewer: APPROVED | CHANGES_REQUESTED
- simplifier: DONE | SKIPPED
- designer: APPROVED | SKIPPED
- tester: PASS | SKIPPED

Checks:
- <local check evidence>

Risks:
- <risk>
```
