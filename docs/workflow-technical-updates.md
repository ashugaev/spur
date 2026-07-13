# Workflow technical updates

Backlog from the adaptive-workflow prose rewrite. Prose ships now; these are runtime/tooling follow-ups.

See also: `docs/context-engineering-backlog.md` — deferred context-engineering runtime items (iteration 2).

## Per-tier model override wiring

Why: tier router assigns opus to uncertainty-reduction/adversarial roles and sonnet to execution, but the runtime spawns one model per session.
Needed: honor each agent's frontmatter `model:` (and codex `model_reasoning_effort`) when launching subagents so the tier assignment takes effect at runtime, not just on paper.

## Cost/success telemetry

Why: routing target is expected cost per successful task, but nothing measures cost or success per tier.
Needed: capture per-task tier, token/dollar cost, gate outcomes, and pass/fail; aggregate so tier thresholds can be tuned from data instead of intuition.

## Claude-side reasoning-budget field asymmetry

Why: codex tomls carry `model_reasoning_effort`; Claude agent frontmatter has no equivalent budget field, so effort is implicit in model choice only.
Needed: decide whether Claude gets an explicit reasoning-budget field and, if so, wire it and mirror the semantics across runtimes.

## Recon-escalation structured loop

Why: escalation ("recon may raise the tier") is prose only; the manager has no structured signal to re-route mid-task.
Needed: a structured escalation output from architect/tier-3 recon that the manager consumes to switch teams, instead of a manual re-read.

## Reconcile telegram SKILL drift

Why: the `telegram` skill differs between `.agents/` and `.claude/` trees; out of scope for this rewrite.
Needed: audit the telegram skill in both trees, pick the source of truth, and re-sync.

## Validate runtime honoring of model fields

Why: this rewrite sets `model:` in md and `model_reasoning_effort` in toml, but nothing confirms Claude or codex actually apply them at spawn.
Needed: a check (test or smoke) that the launched session runs the declared model / reasoning effort for each role.
