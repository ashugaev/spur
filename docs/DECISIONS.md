# Decisions

### DEC-001: Keep auto-merge logic in lifecycle reaction engine
- Context: Existing `auto-merge` reaction is wired in lifecycle but currently does not execute SCM merge.
- Decision: Implement real merge execution directly in lifecycle reaction handler using existing SCM plugin abstraction.
- Consequences: Minimal architectural change, lower risk, and immediate consistency with current reaction framework.

### DEC-002: Keep conflict auto-resolve event-driven via reactions
- Context: Merge conflict handling already has a reaction key (`merge-conflicts`) but needs stronger operational usage.
- Decision: Standardize conflict automation through reaction mapping and `send-to-agent` prompts rather than ad-hoc logic.
- Consequences: Reuses retries/escalation controls and keeps behavior configurable per project.

### DEC-003: Enforce strict retry caps
- Context: Automation loops can silently spin when CI/review/merge states flap.
- Decision: Cap design, review-fix, validate-fix, and conflict retries in orchestrator loop.
- Consequences: Faster escalation to human attention, explicit `BLOCKED` handling, better operational safety.

### DEC-004: Drive merge-conflicts as an auxiliary reaction stream
- Context: Conflict blockers may appear while status remains `approved`, so transition-only reaction triggers can miss them.
- Decision: Track conflict presence per session and emit a dedicated `merge.conflicts` reaction trigger on first detection of each conflict period.
- Consequences: Conflict automation is deterministic and de-duplicated; retries remain governed by existing reaction tracker semantics.
