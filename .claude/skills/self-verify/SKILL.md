---
name: self-verify
description: Validate manager close-out for repo work. Use when implementation is done and the final pass must confirm PR, validation, and required manager gates. Don't use for planning or implementation.
---

SELF VERIFY

  1  Confirm scope: branch, open PR, touched files.
  2  Check criterion evidence and CI notifications; label pending checks.
     No unsupported assumptions or unrelated diff.
  3  Evidence from current branch state; follow `AGENTS.md` validation policy.
  4  Close-out state: changes committed or left uncommitted on purpose,
     branch pushed when required, PR link known.
  5  Compare gates the spec's Verification block plus AGENTS.md routing
     require against actual run evidence; collect gaps as Missing: <gate>.
  6  Report: PASS | MISSING: <gate or evidence> | RERUN: <stale check>.

RULES

  Reject PASS with stale review/validation or PR state violating github close-out rules.
  Report pending CI separately; never claim an unrun check passed.
