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

Route to minimize expected cost per successful task, not per-run tokens. Score each todo with `shallow-scoring` to get a tier, then apply the tier team plus any property modifiers. Run gates in canonical order. Apply the smallest team that covers the todo.

Tier team (from `shallow-scoring`):

| Tier | Team |
|---|---|
| 0 direct | `developer` |
| 1 self-plan | `architect` -> `developer` |
| 2 strong-plan-cheap-exec | `researcher` -> `critic` -> `architect` -> `developer` |
| 3 strong-end-to-end | `developer` launched with a strong-model override (Agent/Task `model` param), running recon + implement in one context; no spec handed off. See `docs/workflow-technical-updates.md` (per-tier model override). |

Property modifiers (orthogonal, add to any tier):

| Property | Add |
|---|---|
| Touches Spur runtime (CLI, daemon, sessions) | `tester` loads the `spur` skill |
| Visible change in `packages/web` | `designer`; `tester` opens the local site with browser tooling, saves screenshots to artifacts, self-analyzes |
| Touches `SKILL.md`, agent definitions, `AGENTS.md`/`CLAUDE.md`, or `.cursor/rules` | `skill-writer` (caveman pass) before `reviewer` |
| Adds or changes user-facing functionality (command, flag, config field, source type, provider, event, install/deploy/CLI behavior), or touches published docs (`docs/`, `README.md`, root doc files) | `docs-management` before `reviewer`; `developer` documents new surface and updates the owning doc in the same change |
| Any code change | `reviewer` -> `tester`; `github` close-out (mandatory PR) |
| Default close-out | `self-verify` |
| Wording-only docs or analysis | close-out only |

Recon before spec: architect (and the tier-3 agent) does recon before writing the spec, not the reverse. Tier starts from the description; recon may raise it per the `shallow-scoring` escalation rule. Re-route to the higher tier's team when it does. Tier teams are planning depth only; reviewer and tester apply to any code change on top of the tier. Tier 0 has no recon or spec — if a change proves larger than one obvious edit mid-flight, escalate to Tier 1+.

## Canonical gate order

`researcher` -> `critic` -> `architect` -> `developer` -> `skill-writer` (caveman) -> `docs-management` -> `code-simplifier` -> `reviewer` -> `designer` -> `tester` -> `github` (close-out) -> `self-verify`.

## Process

1. Intake: parse the user message into concrete todos. State acceptance criteria first. Treat pasted logs, errors, diffs, and PR links as source of truth. Ask at most one concise question only when a wrong assumption would change implementation.
2. Per-todo plan: score with `shallow-scoring` to get a tier. Build the team from the tier plus property modifiers. Track every todo via `TodoWrite`.
3. Execute gates in canonical order, one delegation per step:
   - Research: `researcher` -> `critic`. Critic selects one approach.
   - Clarify: only when ambiguity changes implementation. One batched round.
   - Plan: `architect`.
   - Implement: `developer`.
   - Caveman: `skill-writer` when the diff touches prose surfaces.
   - Docs: `docs-management` when the change adds or alters user-facing functionality or touches published docs. New functionality is documented in the same change; never close out a user-facing change with stale or missing docs.
   - Simplify: `code-simplifier`.
   - Review: `reviewer`.
   - Design: `designer` for visible UI changes.
   - Validate: `tester`.
   - Close-out: `github` gate. Mandatory after any code change. Never close out a code change without an open PR.
   - Verify: `self-verify`.
4. Single-cycle gates: each gate runs once. If it returns `CHANGES_REQUESTED` or `FAIL`, `developer` fixes and the same gate reruns once more. Downstream gates run only when their input changed. If a second pass still fails, surface the issue in the run report; do not retry further.

## Rules

- Collapse phases for trivial work; do not skip the skill.
- One manager step, one todo. Never merge two listed steps into one entry.
- Manager never reads code, edits files, or runs commands. It only delegates and aggregates.
- One phase, one owner, one output.
- Use local checks only. Never wait for remote CI.
- Mirror durable instructions across `AGENTS.md` and `CLAUDE.md` in the same change.
- Mirror agent and skill files across `.agents/` and `.claude/` in the same change.

### Context handoff

- Pass structured artifacts between gates — the spec, the diff, each gate's structured output. Never replay the raw conversation. Each agent starts from facts, not chat.
- Across fix cycles (CHANGES_REQUESTED/FAIL -> developer -> rerun), append new findings to the existing spec/decision record; do not re-summarize from scratch (avoids context collapse).
- When a handoff is insufficient, the agent re-reads the repository rather than reconstructing narrative.
- On longer or multi-cycle tasks (Tier 2/3), invoke `curator` between gates to append new stable facts and a short reflection to the task-memory artifact and refresh the compact handoff. Curator appends and reflects; it never re-summarizes prior entries (context-collapse antipattern). At each handoff, point the receiving gate at `$SPUR_SESSION_ARTIFACTS_DIR/task-memory.md`; the gate reads it when present as starting context.

## Output

```text
## Manager Run

Task:
- <task>

Acceptance criteria:
- <criterion>

Business logic:
- <one or two sentences in plain language: what the change does for the user, what trigger leads to what outcome>

Architecture:
- <one or two sentences: which packages/modules touched, how data flows between them, what new boundaries or contracts exist>

Completed:
- <todo from TodoWrite> — <gate that closed it>

Risks:
- <risk>

Missing (if any):
- <gate or evidence>
```
