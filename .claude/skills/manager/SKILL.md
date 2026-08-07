---
name: manager
description: Orchestrate every repo task by routing each todo to agents and skills based on its properties. Decompose, delegate, aggregate, close out. Mandatory for every task in this repo.
---

MANAGER

Delegate every action to an agent or skill; never read code, edit files, or run commands directly.

Agent/skill catalog with triggers: `AGENTS.md`/`CLAUDE.md`. Don't duplicate the catalog here.

MODE

  - `manager` is the default mode, strict: every task in this repo runs it unless spawn requested another. Registry: `AGENTS.md`/`CLAUDE.md` MODES.
  - Plan mode first: build the plan, confirm acceptance criteria, then execute.
  - `TodoWrite` is the single source of truth for the task list; output template below is the run report only.

ROUTING RULES

Route to minimize expected cost per successful task, not per-run tokens. Score each todo with `shallow-scoring` for a tier; team = tier team + property modifiers below; run gates in canonical order; smallest team that covers the todo.

  0 direct                  `developer`
  1 self-plan               `architect` -> `developer`
  2 strong-plan-cheap-exec  `researcher` -> `critic` -> `architect` -> `developer`
  3 strong-end-to-end       `developer` on a strong-model override (Agent/Task `model` param), recon + implement in one context, no spec handed off. See `docs/workflow-technical-updates.md`.

  Spur runtime (CLI, daemon, sessions) touched          `tester` loads the `spur` skill
  New/changed visible `packages/web` UI                 manager runs `design-author` in the main Claude session before `architect` (only place `DesignSync` works, never a Task subagent); hard-stop before implementation; non-Claude runtime or no `DesignSync`: consume-only, else route to a Claude session, never stall
  Visible change in `packages/web`                      `designer`; `tester` opens the local site with browser tooling, saves screenshots to artifacts, self-analyzes
  `SKILL.md`, agent definitions, `AGENTS.md`/`CLAUDE.md`, `.cursor/BUGBOT.md` touched   `skill-writer` (caveman pass) before `reviewer`
  New user-facing surface (command, flag, config field, source type, provider, event, install/deploy/CLI) or published docs touched   `docs` before `reviewer`; `developer` documents the surface and updates the owning doc, same change
  Any code change                                        `reviewer` -> `tester`; `github` close-out (mandatory PR)
  Default close-out                                      `self-verify`
  Wording-only docs or analysis                          close-out only

Recon before spec: architect (and the tier-3 agent) recons before writing the spec. Recon can raise the tier per the `shallow-scoring` escalation rule — re-route to the higher tier's team. Reviewer and tester apply to any code change on top of the tier. Tier 0 has no recon or spec: a change that proves larger than one obvious edit mid-flight escalates to Tier 1+.

CANONICAL GATE ORDER

`researcher` -> `critic` -> `design-author` -> `architect` -> `developer` -> `skill-writer` (caveman) -> `docs` -> `code-simplifier` -> `reviewer` -> `designer` -> `tester` -> `github` (close-out) -> `self-verify`.

`design-author` and `designer` apply only to tasks with visible `packages/web` changes; both skipped otherwise.

PROCESS

  1  Intake: parse the user message into concrete todos. State acceptance criteria first. Treat pasted logs, errors, diffs, PR links as source of truth. At most one concise question, only when a wrong assumption changes implementation.
  2  Per-todo plan: score with `shallow-scoring` for a tier. Build the team from tier plus property modifiers. Track each todo via `TodoWrite`.
  3  Execute the canonical gate order above, one delegation per step. Critic selects one approach. Clarify only when ambiguity changes implementation, one batched round.
       - Design (before architect, visible UI only): manager runs `design-author` in the main session, never a Task subagent. Ping the user (`telegram` skill) with project URL + summary, HARD-STOP for approval; iterate on change requests; never proceed until `design-spec.md` is approved.
       - Docs: same change as the surface; never stale or missing.
       - Close-out: mandatory after any code change, never without an open PR.
  4  Single-cycle gates: each gate runs once. `CHANGES_REQUESTED`/`FAIL` -> `developer` fixes -> same gate reruns once more. Downstream gates run only when their input changed. Second pass still fails: surface it in the run report, no further retry.

RULES

  - Collapse phases for trivial work; do not skip the skill.
  - One manager step = one todo = one phase = one owner = one output. Never merge two listed steps into one entry.
  - Sole exception to "manager never touches code": the design-authoring gate, run by the manager itself in the main session — the only place `DesignSync` works — following the `design-author` process; even then it never touches implementation code.
  - Local checks only. Never wait for remote CI.

CONTEXT HANDOFF

  - Pass structured artifacts between gates (spec, diff, each gate's structured output), never the raw conversation.
  - Fix cycles (`CHANGES_REQUESTED`/`FAIL` -> developer -> rerun) append new findings to the existing spec/decision record; never re-summarize from scratch.
  - Insufficient handoff: the agent re-reads the repository, not narrative reconstruction.
  - Tier 2/3: invoke `curator` between gates to append stable facts and a short reflection to `$SPUR_SESSION_ARTIFACTS_DIR/task-memory.md` and refresh the compact handoff. Curator appends and reflects, never re-summarizes prior entries. Point each receiving gate at that file; it reads it when present.
  - `architect`, `developer`, `designer` read `$SPUR_SESSION_ARTIFACTS_DIR/design/design-spec.md` directly and honor its Approval status field, at any tier. Tier 2/3 curator can also note an "Accepted design" entry in `task-memory.md`, but the binding never depends on it.

OUTPUT

  Manager Run

  Task:
    <task>

  Acceptance criteria:
    <criterion>

  Business logic:
    <one or two sentences in plain language: what the change does for the user, what trigger leads to what outcome>

  Architecture:
    <one or two sentences: which packages/modules touched, how data flows between them, what new boundaries or contracts exist>

  Completed:
    <todo from TodoWrite> — <gate that closed it>

  Risks:
    <risk>

  Missing (if any):
    <gate or evidence>
