# AO Agent System

## Overview

Autonomous agent pipeline for task delivery. From Jira ticket to merged PR.

## Agents

| Agent | Purpose | Invocation |
|-------|---------|------------|
| `orchestrator` | Run full pipeline | `/orchestrator WEBDEV-XXX` |
| `researcher` | Generate implementation options | `/researcher` |
| `critic` | Evaluate options, select best | `/critic` |
| `architect` | Create detailed plan | `/architect` |
| `developer` | Write code | `/developer` |
| `reviewer` | Code review gate | `/reviewer` |
| `tester` | Validate implementation | `/tester` |
| `designer` | UI review gate | `/designer` |

## Pipeline Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Researcher │────▶│   Critic    │────▶│  Architect  │
└─────────────┘     └─────────────┘     └─────────────┘
                                              │
                                              ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   PR Creator│◀────│   Tester    │◀────│  Developer  │
└─────────────┘     └─────────────┘     └─────────────┘
       ▲                   │                   ▲
       │                   │                   │
       │            ┌──────┴──────┐            │
       │            │  Reviewer   │────────────┘
       │            └─────────────┘       (fix cycle)
       │
       └─── DONE
```

## Quick Start

### Full pipeline
```
/orchestrator WEBDEV-1234
```

### Individual agents
```
/architect    # Plan a task
/developer    # Implement plan
/reviewer     # Review changes
/tester       # Validate implementation
```

## Retry Limits

- **Review cycles**: 3 max → then BLOCKED_REVIEW
- **Test cycles**: 2 max → then BLOCKED_TEST

## Files

- `dev/.ao-agent-rules.md` — full workflow documentation
- `.claude/agents/*.md` — agent definitions
- `.claude/skills/ao-*` — skill implementations

## Usage Notes

1. Start with `/orchestrator` for new tasks
2. Orchestrator routes between agents automatically
3. Blockers escalate to human
4. Post-PR: CI fixer and review fixer handle events
