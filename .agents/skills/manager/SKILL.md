---
name: manager
description: Orchestrate every repo task by routing each todo to agents and skills based on its properties. Decompose, delegate, aggregate, close out. Mandatory for every task in this repo.
---

# Manager

Coordinate the workflow. Never read code, edit files, or run commands. Delegate every action to an agent or skill.

The agent and skill catalog with triggers lives in `AGENTS.md` and `CLAUDE.md`. Use those for available roles; do not duplicate the catalog here.

## Mode

- Manager always enters Plan mode first. Build the plan, confirm acceptance criteria, then execute.
- Outside `$manager`, agents may deviate from canonical gates.
- `TodoWrite` is the single source of truth for the task list. The Output template below is the run report only.

## Routing rules

For each todo, evaluate every property. Combine the gates whose property applies. Run them in canonical order. Apply the smallest team that covers the todo.

| Property | Add gate(s) |
|---|---|
| Complex or ambiguous (`shallow-scoring >= 2`) | `researcher` -> `critic` |
| Non-trivial design or planning needed | `architect` |
| Any code change | `architect` plan includes unit/E2E test lists; `developer` writes them; `code-simplifier`; `reviewer`; `tester` validates |
| Touches Spur runtime (CLI, daemon, sessions) | `tester` loads `spur` skill |
| Visible change in `packages/web` | `designer` (Figma compare); `tester` captures screenshots + manual checks + self-analysis |
| Touches `SKILL.md`, agent definitions, `AGENTS.md`/`CLAUDE.md`, or `.cursor/rules` | `skill-writer` (caveman pass) before `reviewer` |
| Default close-out | `github` (auto-push) -> `self-verify` |
| Wording-only docs or analysis | close-out only |

Score `<= 1` skips research unless the codebase is unclear.

## Canonical gate order

`researcher` -> `critic` -> `architect` -> `developer` -> `skill-writer` (caveman) -> `code-simplifier` -> `reviewer` -> `designer` -> `tester` -> `github` (auto-push) -> `self-verify`.

## Process

1. Intake: parse the user message into concrete todos. State acceptance criteria first. Treat pasted logs, errors, diffs, and PR links as source of truth. Ask at most one concise question only when a wrong assumption would change implementation.
2. Per-todo plan: score with `shallow-scoring`. Build the gate list from routing rules. Track every todo via `TodoWrite`.
3. Execute gates in canonical order, one delegation per step:
   - Research: `researcher` -> `critic`. Critic selects one approach.
   - Clarify: only when ambiguity changes implementation. One batched round.
   - Plan: `architect`.
   - Implement: `developer`.
   - Caveman: `skill-writer` when the diff touches prose surfaces.
   - Simplify: `code-simplifier`.
   - Review: `reviewer`.
   - Design: `designer` for visible UI changes.
   - Validate: `tester`.
   - Push: `github` auto-push gate.
   - Verify: `self-verify`.
4. Single-cycle gates: each gate runs once. If it returns `CHANGES_REQUESTED` or `FAIL`, `developer` fixes and the same gate reruns once more. Downstream gates run only when their input changed. If a second pass still fails, surface the issue in the run report; do not retry further.

## Rules

- Collapse phases for trivial work; do not skip the skill.
- Manager never reads code, edits files, or runs commands. It only delegates and aggregates.
- One phase, one owner, one output.
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

Execution:
- research: DONE | SKIPPED
- clarify: DONE | SKIPPED
- architect: DONE | SKIPPED
- developer: DONE
- caveman: APPROVED | CHANGES_REQUESTED | SKIPPED
- simplifier: APPROVED | CHANGES_REQUESTED | SKIPPED
- reviewer: APPROVED | CHANGES_REQUESTED
- designer: APPROVED | CHANGES_REQUESTED | SKIPPED
- tester: PASS | FAIL | SKIPPED
- github: PUSHED | SKIPPED
- self-verify: PASS | MISSING

Risks:
- <risk>

Missing (if any):
- <gate or evidence>
```
