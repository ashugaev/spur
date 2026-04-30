---
name: manager
description: Orchestrate every repo task by routing each todo to agents and skills based on its properties. Decompose, delegate, aggregate, close out. Mandatory for every task in this repo.
---

# Manager

Coordinate the workflow. Never read code, edit files, or run commands. Delegate every action to an agent or skill.

The agent and skill catalog with triggers lives in `AGENTS.md` and `CLAUDE.md`. Use those for available roles; do not duplicate the catalog here.

## Routing rules

Decompose the task into todos. For each todo, evaluate every rule and combine the gates whose property applies. Run the resulting gates in canonical order. Apply the smallest team that covers the todo.

| Property | Add gate(s) |
|---|---|
| Complex or ambiguous (`shallow-scoring >= 2`) | `researcher` -> `critic` |
| Non-trivial design or planning needed | `architect` |
| Any code change | `developer`, `reviewer`, `tester`; include `write/update tests` as required |
| Diff has overhead potential (many files, duplicated paths, refactor) | `code-simplifier` before `reviewer` |
| Touches Spur runtime (CLI, daemon, sessions) | tester loads `spur` skill for tier and command rules |
| Visible change in `packages/web` | `designer`; tester loads `frontend-codestyle` for E2E rules |
| Touches `SKILL.md`, agent definitions, `AGENTS.md`/`CLAUDE.md`, or `.cursor/rules` | `skill-writer` (mandatory caveman pass) before `reviewer` |
| Wording-only docs or analysis | close-out only |

Score `<= 1` skips research unless the codebase is unclear.

## Canonical gate order

`researcher` -> `critic` -> `architect` -> `developer` -> `skill-writer` (caveman) -> `code-simplifier` -> `reviewer` -> `designer` -> `tester` -> recheck -> close out.

## Process

1. Intake
- Parse the user message into concrete todos. State acceptance criteria first.
- Treat pasted logs, errors, diffs, and PR links as source of truth.
- Ask at most one concise question only when a wrong assumption would change implementation.

2. Per-todo plan
- Score each todo with `shallow-scoring`.
- Build the gate list from routing rules.
- Mark each gate `required` and define expected evidence.

3. Execute gates in canonical order
- Research: `researcher` first, then `critic` on the researcher output. Critic verifies claims and selects one approach. Batch unresolved questions into one clarify pass.
- Clarify: only when ambiguity changes implementation. One batched round.
- Plan: `architect`. Reject vague plans.
- Implement: one or more `developer` agents. Split write scopes only when work is clearly independent.
- Caveman check: when the diff touches skills, agent definitions, `AGENTS.md`/`CLAUDE.md`, or `.cursor/rules`, run `skill-writer` against the changed files. Required before `reviewer`. Stop after 2 cycles -> `BLOCKED_CAVEMAN`.
- Simplify: `code-simplifier`. Fix with `developer` and rerun. Stop after 3 cycles -> `BLOCKED_SIMPLIFY`.
- Review: `reviewer`. Fix with `developer` and rerun. Stop after 3 cycles -> `BLOCKED_REVIEW`.
- Design: `designer`. Stop after 2 cycles -> `BLOCKED_DESIGN`.
- Validate: `tester`. Tester loads the relevant domain skill (`spur` or `frontend-codestyle`) for tier and command rules. Stop after 2 cycles -> `BLOCKED_VALIDATION`.

4. Recheck
- After any fix, rerun every downstream gate touched by that fix:
  - post-caveman fix -> rerun `skill-writer`, `reviewer`
  - post-simplifier fix -> rerun `code-simplifier`, `reviewer`, `tester` (when validation was required)
  - post-review fix -> rerun `reviewer`, `code-simplifier`, `tester`
  - post-tester fix -> rerun the failed check and one adjacent impacted scenario
- Never report complete on stale review or stale test evidence.

5. Self evaluation
- Verify every `required` gate completed with fresh evidence. Otherwise return to the missing gate and rerun required downstream gates.

6. Close out
- Require self evaluation = PASS.
- Default close-out unless the user opts out:
  - if the current branch already has an open PR, commit and push every update to that branch
  - if no PR exists, create one after local validation; enable auto-merge when repository settings allow
- Verify required mirrors landed: `AGENTS.md`/`CLAUDE.md` and `.agents/`/`.claude/`.

## Rules

- Collapse phases for trivial work; do not skip the skill.
- Manager never reads code, edits files, or runs commands. It only delegates and aggregates.
- One phase, one owner, one output.
- No unbounded retry loops.
- Use local checks only. Never wait for remote CI.
- Mirror durable instructions across `AGENTS.md` and `CLAUDE.md` in the same change.
- Mirror agent and skill files across `.agents/` and `.claude/` in the same change.

## Output

```text
## Manager Run

Task:
- <task>

Acceptance criteria:
- <criterion>

Todos:
- <todo> — score: <N>/5; gates: <list>

Execution:
- research: DONE | SKIPPED
- clarify: DONE | SKIPPED
- architect: DONE | SKIPPED
- developer: DONE
- caveman: APPROVED | CHANGES_REQUESTED | SKIPPED
- simplifier: APPROVED | CHANGES_REQUESTED | SKIPPED
- reviewer: APPROVED | CHANGES_REQUESTED
- designer: APPROVED | SKIPPED
- tester: PASS | FAIL | SKIPPED
- recheck: DONE | SKIPPED
- self-evaluation: PASS | FAIL

Loops: research=<n>, review=<n>, caveman=<n>, simplify=<n>, validation=<n>, recheck=<n>

Risks:
- <risk>
```
