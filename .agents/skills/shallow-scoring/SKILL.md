---
name: shallow-scoring
description: Route a task to a deliberation tier by ambiguity × blast radius. No tools, pure reasoning, < 5 seconds.
---

# Tier Router

Pick a deliberation tier from the task description alone. No codebase exploration. Fast.

Two axes, each low | med | high:

- Ambiguity: how well-defined the requirement is and how known the target architecture is. Vague ask or unfamiliar area is high.
- Blast radius: how much breaks if the direction is wrong. Shared contract, core runtime, or many call-sites is high.

## Tiers

| Tier | When | Team |
|------|------|------|
| 0 direct | ambiguity low AND blast low | developer only. Smallest change, follow the nearest pattern, targeted verification. No researcher/critic/architect. |
| 1 self-plan | moderate ambiguity, contained blast | architect concise spec -> developer. Skip researcher/critic. |
| 2 strong-plan-cheap-exec | ambiguity high OR blast high | researcher -> critic -> architect -> developer -> review/test. Default for real features. |
| 3 strong-end-to-end | high implementation complexity with continuous replanning: debug unknown cause, races, perf, deep type-level, large dynamic refactor | one strong agent does recon + plan + implement. Do not hand a spec to a cheap executor. Run the executor on a strong model (override), not the default cheap tier. |

## Escalation

Initial tier comes from the description. Recon may raise the tier when the codebase proves more entangled than the description implied. Never silently lower.

## Output
```
Ambiguity: low | med | high
Blast radius: low | med | high
Tier: 0 | 1 | 2 | 3
Reason: <one sentence>
```
