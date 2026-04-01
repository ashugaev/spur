---
name: self-verify
description: Validate manager close-out for repo work. Use when implementation is done and the final pass must confirm PR, validation, and required manager gates. Don't use for planning or implementation.
---

# Self Verify

Run this at the end of repo work.

## Procedure

1. Confirm scope:
   - current branch
   - open PR for the branch
   - touched files
2. Confirm manager requirements for the touched scope are satisfied:
   - required build ran
   - required tests ran
   - review happened
   - simplifier pass happened when applicable
3. Confirm evidence is fresh:
   - use checks from the current branch state
   - rerun stale or missing validation before sign-off
4. Confirm close-out state:
   - local changes are committed or intentionally left uncommitted
   - branch is pushed when default close-out requires it
   - PR link is known
5. Report only:
   - PASS
   - BLOCKED: <missing requirement>
   - RERUN: <stale check>

## Hard Rules

- Do not claim PASS without an open PR.
- Do not claim PASS if a required build or test tier is missing.
- Do not claim PASS on stale review or stale validation.
- Keep the report short and concrete.
