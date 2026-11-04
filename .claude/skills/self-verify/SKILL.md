---
name: self-verify
description: Validate manager close-out for repo work. Use when implementation is done and the final pass must confirm PR, validation, and required manager gates. Don't use for planning or implementation.
---

SELF VERIFY

  1  Confirm scope: branch, open PR, touched files.
  2  Evidence checklist: tester PASS, required named targeted checks passed,
     every acceptance criterion covered, no unsupported assumptions,
     diff carries nothing unrelated.
  3  Evidence from current branch state; rerun stale affected-boundary checks and required runtime/UI proof. Leave broad suites/build/typecheck/lint/e2e to GitHub CI.
  4  Close-out state: changes committed or left uncommitted on purpose,
     branch pushed when required, PR link known.
  5  Compare gates the spec's Verification block plus AGENTS.md routing
     require against actual run evidence; collect gaps as Missing: <gate>.
  6  Report: PASS | MISSING: <gate or evidence> | RERUN: <stale check>.

RULES

  Reject PASS with missing required checks, stale review/validation or PR state violating github close-out rules.
  Report short, concrete.
  Reject missing, failed, skipped or stale required manual scenarios.
  Enforce manager's manual-proof and required-CI release gate.
  Leave required-CI inspection to owner at authorized merge gate; never claim an unrun check passed.
