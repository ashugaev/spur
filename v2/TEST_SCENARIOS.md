# Test Scenarios

## Fast

- Codex restore with parent plus newer subagent rollout: `findCodexSessionId` ignores `session_meta.source.subagent` records and resumes the parent `source: "cli"` thread for the worktree.
