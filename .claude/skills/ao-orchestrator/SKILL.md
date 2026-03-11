---
name: ao-orchestrator
description: AO pipeline orchestrator. Manages the full workflow from task to PR. Routes between agents based on verdicts.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

# AO Pipeline Orchestrator

Manage the full delivery workflow. Route tasks between agents based on verdicts.

## Pipeline States

```
INIT → RESEARCH → PLANNING → IMPLEMENTING → REVIEWING → TESTING → PR_CREATING → DONE
                                    ↑            ↓
                                    └── REWORK ──┘
                                    
                              BLOCKED_REVIEW | BLOCKED_TEST (terminal)
```

## Context

Environment variables:
- `AO_ISSUE_ID` — the Jira issue key
- `AO_SESSION` — unique session ID
- `AO_DATA_DIR` — session data directory

State file: `${AO_DATA_DIR}/state.json`

---

## Entry Points

### New task
```
/ao run <ISSUE-ID>
```
1. Initialize session
2. Set state to INIT
3. Start pipeline

### Resume
```
/ao resume
```
1. Read state
2. Continue from current phase

---

## Phase: INIT

1. Fetch issue details (if Jira MCP available)
2. Create session directory
3. Initialize state:
   ```json
   {
     "issue_id": "WEBDEV-XXX",
     "state": "INIT",
     "complexity_score": null,
     "review_attempts": 0,
     "test_attempts": 0,
     "created_at": "<timestamp>"
   }
   ```
4. **Quick complexity assessment** (no tools, pure reasoning, < 5 sec):

   Score the task on a 1–5 scale based solely on the task description:

   | Score | Meaning | Criteria |
   |-------|---------|----------|
   | 1 | Trivial | Single file, < 3 steps, no design decisions, obvious implementation |
   | 2 | Simple | 2–5 files, clear approach, minor trade-offs |
   | 3 | Moderate | Multiple files/packages, some design decisions required |
   | 4 | Complex | Cross-cutting concerns, multiple valid approaches, significant risk |
   | 5 | Very complex | Deep architectural decisions, high uncertainty, many unknowns |

   Store score in state: `"complexity_score": <N>`

5. Route based on score:
   - Score **1** → skip RESEARCH entirely, go directly to PLANNING
   - Score **> 1** → run full RESEARCH (options + evaluation + selected approach)

---

## Phase: RESEARCH (complexity score > 1 only)

Invoke: `/ao-architect` with research mode

Expected output: Options + Evaluation + Selected approach

On complete:
- Extract selected option
- Update state: `"state": "PLANNING"`
- Proceed

---

## Phase: PLANNING

Invoke: `/ao-architect` with planning mode (or combined output from RESEARCH)

Expected output: Plan with steps, criteria, risks

Check for Open Questions:
- If present → invoke `/ao-chat-with-user`, wait
- If none → proceed

On complete:
- Store plan in state
- Update state: `"state": "IMPLEMENTING"`

---

## Phase: IMPLEMENTING

Check if parallelizable:
- Single scope → invoke `/ao-developer` once
- Multiple scopes → invoke `/ao-developer` per scope (non-overlapping files)

On complete:
- Update state: `"state": "REVIEWING"`

---

## Phase: REVIEWING

Invoke: `/ao-reviewer`

Read verdict:
- **APPROVED** → update state: `"state": "TESTING"`
- **CHANGES_REQUESTED**:
  - Increment `review_attempts`
  - If < 3 → route back to IMPLEMENTING
  - If >= 3 → update state: `"state": "BLOCKED_REVIEW"`, stop

---

## Phase: TESTING

Invoke: `/ao-tester`

Read verdict:
- **PASS** → update state: `"state": "PR_CREATING"`
- **FAIL**:
  - Increment `test_attempts`
  - If < 2 → route back to IMPLEMENTING
  - If >= 2 → update state: `"state": "BLOCKED_TEST"`, stop

---

## Phase: PR_CREATING

Invoke: `/ao-pr-creator`

On complete:
- Store PR URL
- Update state: `"state": "DONE"`
- Output summary

---

## Post-PR Events

Monitor signals file for:
- `CI_FAILED` → invoke `/ao-ci-fixer`
- `REVIEW_COMMENTS` → invoke `/ao-review-fixer`

---

## State Management

### Read state
```bash
cat "${AO_DATA_DIR}/state.json"
```

### Update state
```bash
jq '.state = "NEW_STATE"' "${AO_DATA_DIR}/state.json" > tmp && mv tmp "${AO_DATA_DIR}/state.json"
```

### Log transition
```bash
echo "$(date -Iseconds) | ${OLD_STATE} → ${NEW_STATE}" >> "${AO_DATA_DIR}/transitions.log"
```

---

## Decision Tree Summary

```
START
  │
  ├─ Assess complexity (1–5, no tools, pure reasoning)
  │
  ├─ Score = 1? ─YES─→ PLANNING
  │     │
  │    NO (score > 1)
  │     ↓
  │  RESEARCH (options + evaluate)
  │     │
  │     ↓
  └──→ PLANNING (create plan)
         │
         ├─ Open Questions? ─YES─→ CHAT (wait for human)
         │     │
         │    NO
         │     ↓
         └──→ IMPLEMENTING
                │
                ↓
              REVIEWING
                │
         ┌──────┴──────┐
      APPROVED    CHANGES_REQ
         │          │
         │     attempt < 3? ─YES─→ back to IMPLEMENTING
         │          │
         │         NO
         │          ↓
         │     BLOCKED_REVIEW
         ↓
      TESTING
         │
    ┌────┴────┐
  PASS      FAIL
    │         │
    │    attempt < 2? ─YES─→ back to IMPLEMENTING
    │         │
    │        NO
    │         ↓
    │    BLOCKED_TEST
    ↓
 PR_CREATING
    │
    ↓
  DONE
```

---

## Output Format

### Progress update
```
## Pipeline: <ISSUE-ID>

State: <current>
Phase: <description>
Attempts: review <N>/3, test <N>/2

Last action: <what happened>
Next: <what's coming>
```

### Final summary
```
## Completed: <ISSUE-ID>

PR: <url>
Commits: <count>
Review cycles: <N>
Test cycles: <N>

Files changed:
- <list>
```

### Blocked summary
```
## BLOCKED: <ISSUE-ID>

State: BLOCKED_REVIEW | BLOCKED_TEST
Reason: <why>
Attempts: review <N>/3, test <N>/2

Last issues:
- <list from last verdict>

Action needed: <what human should do>
```
