---
name: self-verify
description: Validate manager close-out for repo work. Use when implementation is done and the final pass must confirm PR, validation, and required manager gates. Don't use for planning or implementation.
---

# Self Verify

## Process

1. Confirm scope: current branch, open PR for the branch, touched files.
2. Observable-signal checklist (evidence, not opinion):
   - tests passed on the current branch state
   - typecheck passed
   - every acceptance criterion in the spec covered by a run verification
   - no unsupported assumptions remain
   - diff carries no changes unrelated to the task
3. Confirm evidence is fresh: use checks from the current branch state; rerun stale or missing validation before sign-off.
4. Confirm close-out state: local changes committed or intentionally left uncommitted; branch pushed when default close-out requires it; PR link known.
5. Re-walk against the spec's Verification block plus `AGENTS.md` routing gates. List the gates that should have run for this diff; compare to actual run evidence; collect each gap as `Missing: <gate>`.
6. Report only: `PASS` | `MISSING: <gate or evidence>` | `RERUN: <stale check>`.

## Rules

- Do not claim PASS without an open PR.
- Do not claim PASS if a required build or test tier is missing.
- Do not claim PASS on stale review or stale validation.
- Keep the report short and concrete.
