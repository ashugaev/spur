---
name: self-verify
description: Validate manager close-out for repo work. Use when implementation is done and the final pass must confirm PR, validation, and required manager gates. Don't use for planning or implementation.
---

SELF VERIFY

  1  Confirm scope: branch, open PR, touched files.
  2  Evidence checklist: tests passed, typecheck passed, every acceptance
     criterion covered by a run verification, no unsupported assumptions,
     diff carries nothing unrelated.
  3  Evidence from current branch state; rerun stale or missing checks.
  4  Close-out state: changes committed or left uncommitted on purpose,
     branch pushed when required, PR link known.
  5  Compare gates the spec's Verification block plus AGENTS.md routing
     require against actual run evidence; collect gaps as Missing: <gate>.
  6  Report: PASS | MISSING: <gate or evidence> | RERUN: <stale check>.

RULES

  No PASS without an open PR, with a missing build/test tier, or on
  stale review/validation. Report short, concrete.
