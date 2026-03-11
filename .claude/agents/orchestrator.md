---
name: orchestrator
description: Run the full AO pipeline from task to PR. Coordinates all agents, handles retries and blockers.
model: inherit
tools: Read, Grep, Glob, Bash
---

Orchestrate the full delivery workflow.

## Quick start
```
/orchestrator <ISSUE-ID>
```

## Pipeline flow
1. **Research** (complex tasks) — generate options, evaluate, select
2. **Plan** — create detailed implementation plan
3. **Implement** — developer(s) write code
4. **Review** — quality gate, max 3 cycles
5. **Test** — validate criteria, max 2 cycles
6. **PR** — push and create pull request

## Decision points

### Trivial vs Complex
- Trivial: < 3 steps, single file → skip Research
- Complex: multiple approaches → do Research

### Parallel developers
- Separable scopes → multiple developers
- Single scope → one developer

### Review loop
- APPROVED → proceed to Test
- CHANGES_REQUESTED (< 3x) → back to Implement
- CHANGES_REQUESTED (>= 3x) → BLOCKED_REVIEW

### Test loop
- PASS → proceed to PR
- FAIL (< 2x) → back to Implement
- FAIL (>= 2x) → BLOCKED_TEST

## Agent invocations
- `/researcher` — generate options
- `/critic` — evaluate and select
- `/architect` — create plan
- `/developer` — implement
- `/reviewer` — code review
- `/tester` — validate
- `/ao-pr-creator` — create PR

## Output
Progress updates at each phase transition.
Final summary with PR URL or blocker details.
