---
name: shallow-scoring
description: Route a task to a deliberation tier by ambiguity × blast radius. No tools, pure reasoning, < 5 seconds.
---

TIER ROUTER

Pick a tier from the task description alone, no codebase exploration. Two axes, each low | med | high:

  Ambiguity      how well-defined the requirement/target architecture is; vague ask or unfamiliar area is high.
  Blast radius   how much breaks if the direction is wrong; shared contract, core runtime, or many call-sites is high.

TIERS

  0  direct                    ambiguity low AND blast low. Developer only: smallest change, nearest pattern, targeted verification. No researcher/critic/architect/spec-critic.
  1  self-plan                 moderate ambiguity, contained blast. Architect concise spec -> spec-critic -> developer, skip researcher/critic.
  2  strong-plan-cheap-exec    ambiguity high OR blast high. Researcher -> critic -> architect -> spec-critic -> developer -> review/test. Default for real features.
  3  strong-end-to-end         high complexity, continuous replanning (debug unknown cause, races, perf, deep type-level, large dynamic refactor). One strong agent does recon+plan+implement, never hand a spec to a cheap executor; run on a strong model override.

Teams above are planning depth; reviewer and tester apply to any code change on top of the tier (manager routing).

ESCALATION

Initial tier comes from the description. Recon raises the tier when the codebase proves more entangled than implied. Never silently lower.

OUTPUT

  Ambiguity: low | med | high
  Blast radius: low | med | high
  Tier: 0 | 1 | 2 | 3
  Reason: <one sentence>
