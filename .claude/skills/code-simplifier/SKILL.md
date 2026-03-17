---
name: code-simplifier
description: Make code, configs, docs, and prompts leaner in this repo. Use when the task is to simplify, reduce abstraction or duplication, delete dead paths, or pressure-test whether a change can be smaller.
---

# Code Simplifier

Use this skill when less complexity is the goal.

Default stance: first delete, then merge, then shorten, and only then rewrite.

## Protocol

1. State the job in one sentence. If that is hard, the design probably does too many things.
2. Find complexity before adding code:
   - duplicate paths
   - speculative hooks
   - fallback branches in core logic
   - extra config surface
   - broad data shapes
   - repeated defaults
   - docs or prompts compensating for a confusing design
3. For each piece, ask in order:
   - Can this be deleted?
   - Can two paths become one?
   - Can this move to a boundary once instead of being handled everywhere?
   - Can the type or config shape be narrower?
   - Can the same behavior use fewer concepts?
4. Prefer one clear interface, one runtime path, and one source of truth.
5. Prefer explicit data over clever abstraction unless the abstraction removes real repetition now.
6. Implement the smallest diff that materially reduces complexity.
7. Report what was removed, merged, narrowed, or shortened, plus any complexity that must remain.

## Heuristics

- Delete dead code instead of keeping placeholders.
- Remove alternate APIs unless both are required right now.
- Inline one-off helpers that only hide simple behavior.
- Collapse duplicated conditionals and fallback handling.
- Apply defaults once at the edge.
- Shorten docs and prompts after simplifying the underlying behavior.
- If a branch exists only for "maybe later", cut it.

## Review Lens

- Is there a smaller valid solution?
- Are we solving the same problem in two places?
- Is the abstraction cheaper than plain code?
- Is any fallback in core logic avoidable?
- Can naming, typing, or control flow become more direct?
