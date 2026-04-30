---
name: code-simplifier
description: Make code, configs, docs, and prompts leaner in this repo. Use when the task is to simplify, reduce abstraction or duplication, delete dead paths, or pressure-test whether a change can be smaller.
---

# Code Simplifier

Order: delete -> merge -> shorten -> rewrite.

## Process

1. State the job in one sentence. If hard, the design does too many things.
2. Find complexity: duplicate paths, speculative hooks, fallbacks in core logic, extra config surface, broad data shapes, repeated defaults, docs that compensate for confusing design.
3. For each piece, ask in order:
   - Can this be deleted?
   - Can two paths become one?
   - Can this move to a boundary instead of being handled everywhere?
   - Can the type or config shape be narrower?
   - Can the same behavior use fewer concepts?
4. Prefer one interface, one runtime path, one source of truth.
5. Prefer explicit data over abstraction unless the abstraction removes real repetition now.
6. Implement the smallest diff that materially reduces complexity.
7. Report what was removed, merged, narrowed, or shortened, plus complexity that must remain.

## Heuristics

- Delete dead code; do not leave placeholders.
- Drop alternate APIs unless both are required now.
- Inline one-off helpers that only hide simple behavior.
- Collapse duplicated conditionals and fallback handling.
- Apply defaults once at the edge.
- Cut "maybe later" branches.
- Shorten docs and prompts after the underlying behavior is simpler.
