# Queue

## TODO
No open tasks.

## IN_PROGRESS

## DONE
### TASK-001: Implement Real Auto-Merge Reaction
- Status: DONE
- Priority: P0
- Owner: developer-pr-merge
- Description: Replace `auto-merge` placeholder behavior with actual SCM merge execution in lifecycle reaction engine.
- Acceptance Criteria:
  - [x] `auto-merge` calls SCM merge for eligible PRs.
  - [x] Guardrails prevent merge when PR is missing, closed, or not mergeable.
  - [x] Result is surfaced as success/failure without crashing polling loop.
- Dependencies: none

### TASK-002: Implement Merge-Conflict Auto-Resolve Reaction Flow
- Status: DONE
- Priority: P0
- Owner: developer-conflict-resolver
- Description: Ensure merge-conflict situations trigger reaction path that automatically prompts agent to rebase/resolve conflicts.
- Acceptance Criteria:
  - [x] Conflict condition maps to `merge-conflicts` reaction key.
  - [x] `send-to-agent` message dispatches for configured merge-conflict reactions.
  - [x] Escalation and retry boundaries remain intact.
- Dependencies: TASK-001

### TASK-003: Add/Update Lifecycle Reaction Tests
- Status: DONE
- Priority: P0
- Owner: tester
- Description: Add test coverage for auto-merge and merge-conflict flows in lifecycle manager.
- Acceptance Criteria:
  - [x] Success-path test for `auto-merge` with mergeable open PR.
  - [x] Failure-path tests for non-mergeable/non-open/no-PR conditions.
  - [x] Reaction test for conflict flow using `merge-conflicts` configuration.
- Dependencies: TASK-001, TASK-002

### TASK-004: Update User-Facing Docs and Examples
- Status: DONE
- Priority: P1
- Owner: collaborator
- Description: Document the now-working auto-merge path and conflict auto-resolution setup.
- Acceptance Criteria:
  - [x] README and examples explain how to enable both capabilities.
  - [x] Core README reaction notes are accurate.
- Dependencies: TASK-001, TASK-002

## BLOCKED
