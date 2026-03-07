# Objective

## Goal
Deliver a production-ready PR pipeline capability that can:
1. automatically merge approved and green pull requests, and
2. automatically trigger conflict-resolution work when merge conflicts appear.

## Success Criteria
- [x] `approved-and-green` reaction with `action: auto-merge` performs a real SCM merge (not notification only).
- [x] Merge happens only for safe conditions: PR exists, PR open, mergeability true.
- [x] Merge conflict conditions trigger a dedicated `merge-conflicts` reaction path with agent-facing remediation prompt.
- [x] Reaction behavior is covered by unit tests for success and failure paths.
- [x] Relevant package builds pass before closing implementation.

## Constraints
- Keep behavior backward-compatible for existing `notify` and `send-to-agent` reactions.
- Do not introduce unbounded retries; all loops must have explicit caps.
- Keep ownership explicit across orchestrator state files.
- Keep implementation minimal and aligned with current lifecycle architecture.
