---
name: code-simplifier
description: Make code, configs, docs, and prompts leaner in this repo. Use when the task is to simplify, reduce abstraction or duplication, delete dead paths, or pressure-test whether a change can be smaller.
---

CODE SIMPLIFIER: delete -> merge -> shorten -> rewrite.

  1  State the job in one sentence; hard to state, design does too much.
  2  Find complexity: duplicate paths, speculative hooks, fallbacks in
     core logic, extra config, broad data shapes, repeated defaults,
     docs that compensate for confusing design.
  3  Ask in order: delete this? two paths become one? move to a boundary?
     narrower type or config shape? same behavior, fewer concepts?
  4  Prefer explicit data over abstraction unless the abstraction removes
     real repetition now.
  5  One interface, one runtime path, one source of truth; smallest diff
     that materially reduces complexity.
  6  Report removed, merged, narrowed, shortened, plus complexity that
     must remain.

HEURISTICS

  - Delete dead code, no placeholders.
  - Drop alternate APIs unless both required now.
  - Inline one-off helpers that only hide simple behavior.
  - Collapse duplicated conditionals and fallback handling.
  - Apply defaults once at the edge.
  - Cut "maybe later" branches.
  - Shorten docs and prompts after the underlying behavior is simpler.
