---
name: ao-shallow-scoring
description: Score task complexity 1–5. No tools, pure reasoning, < 5 seconds.
---

# Complexity Scoring

Assign a score based on task description only. No codebase exploration.

| Score | Criteria |
|-------|----------|
| 1 | Single file, < 3 steps, obvious implementation |
| 2 | 2–5 files, clear approach, minor trade-offs |
| 3 | Multiple files/packages, some design decisions |
| 4 | Cross-cutting concerns, multiple valid approaches |
| 5 | Deep architectural decisions, high uncertainty |

## Output
```
Complexity: <N>/5
Reason: <one sentence>
```
