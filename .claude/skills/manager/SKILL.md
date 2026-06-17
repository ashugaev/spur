---
name: manager
description: Route repo tasks through required gates. Mandatory for every task.
---

# Manager

Coordinate workflow. Delegate every action to an agent or skill.

Catalog lives in `AGENTS.md` and `CLAUDE.md`; do not duplicate it.

## Mode

- Enter Plan mode first. Build plan, confirm criteria, execute.
- Outside `$manager`, agents may deviate from canonical gates.
- `TodoWrite` owns task list. Output template is run report only.

## Routing rules

For each todo, apply every matching property. Run gates in canonical order. Use smallest team.

| Property | Add gate(s) |
|---|---|
| Complex or ambiguous (`shallow-scoring >= 2`) | `researcher` -> `critic` |
| Non-trivial design or planning needed | `architect` |
| Any code change | `architect` lists unit/E2E tests; `developer` writes them; `code-simplifier`; `reviewer`; `tester`; `github` PR |
| Touches Spur runtime (CLI, daemon, sessions) | `tester` loads `spur` skill |
| Visible `packages/web` change | `architect` lists UI scenarios before steps and maps coverage; `tester` opens local site with browser tools, no scripts, saves screenshots to artifacts, self-analyzes; `designer` inspects captured images |
| Touches `SKILL.md`, agent definitions, `AGENTS.md`/`CLAUDE.md`, or `.cursor/rules` | `skill-writer` (caveman pass) before `reviewer` |
| Default close-out | `self-verify` |
| Wording-only docs or analysis | close-out only |

Score `<= 1` skips research unless the codebase is unclear.

## Canonical gate order

`researcher` -> `critic` -> `architect` -> `developer` -> `skill-writer` (caveman) -> `code-simplifier` -> `reviewer` -> `tester` -> `designer` -> `github` (close-out) -> `self-verify`.

## Process

1. Intake: parse todos. State criteria first. Treat pasted logs/errors/diffs/PR links as source. Ask one question only when needed.
2. Per-todo plan: score with `shallow-scoring`. Build gates. Track todos via `TodoWrite`.
3. Execute gates in canonical order, one delegation per step:
   - Research: `researcher` -> `critic`. Critic selects one approach.
   - Clarify: only when ambiguity changes implementation. One batched round.
   - Plan: `architect`.
   - Implement: `developer`.
   - Caveman: `skill-writer` when the diff touches prose surfaces.
   - Simplify: `code-simplifier`.
   - Review: `reviewer`.
   - Validate: `tester`.
   - Design: `designer` for visible UI changes after tester screenshots exist.
   - Close-out: `github`. Mandatory after code changes; PR required.
   - Verify: `self-verify`.
4. Single-cycle gates: each gate runs once. On `CHANGES_REQUESTED` or `FAIL`, `developer` fixes and gate reruns once. If still failing, report; no further retry.

## Rules

- Collapse trivial phases; do not skip this skill.
- Manager never reads code, edits files, or runs commands.
- One phase, one owner, one output.
- Use local checks only. Never wait for remote CI.
- Mirror `AGENTS.md` and `CLAUDE.md`.
- Mirror `.agents/` and `.claude/`.

## Output

```text
## Manager Run

Task:
- <task>

Acceptance criteria:
- <criterion>

Business logic:
- <what changes for user; trigger -> outcome>

Architecture:
- <packages/modules touched; data flow; boundaries>

Completed:
- <todo from TodoWrite> - <gate that closed it>

Risks:
- <risk>

Missing (if any):
- <gate or evidence>
```
