---
name: docs
description: Governs published docs (README.md, docs/, SETUP/TROUBLESHOOTING/CONTRIBUTING/SECURITY). Load on any published-doc edit — create, change, move, trim, or link fix. Enforces open-source standards: Diataxis mode, granular single-topic files, caveman prose, one source per topic, link don't restate. Not for config/command field semantics (docs/configuration.md + docs/commands.md, owned by the config-doc rule and spur skill) or SKILL.md/agent prose (skill-writer).
---

DOCS MANAGEMENT: root README is a minimal hub, Docs section lists every
published doc plus the AI-agent install prompt; reference lives in docs/.

WRITE CAVEMAN

  Cut what a mid dev or agent already knows (npm, systemd, git, nginx
  basics); state the gotcha, skip the step. No filler, self-narration
  ("as noted", "simply", "note that"), marketing, future promises, time words
  ("now", "currently"). Fragments OK, imperative, one term per concept.

GRANULAR: one doc, one topic, one Diataxis mode; split on drift.

  Tutorial (first run)          docs/install-from-npm.md
  How-to (one task)             docs/install-from-source.md, docs/voice.md,
                                 TROUBLESHOOTING.md, SETUP.md
  Reference (commands, fields)  docs/commands.md, docs/configuration.md
  Explanation (why)             gitignored planning notes, not shipped

ONE SOURCE: each topic has one owning doc, everything else links.

  Commands: docs/commands.md only. Config fields: docs/configuration.md only.
  Contradiction: pick the owner, delete the copy, link.

LINK GRAPH: every published doc reachable from the README Docs section, relative links only.

  Rename or move updates every inbound reference: markdown links, the .claude/.agents
  skill trees, CI path filters in .github/workflows/*.yml — link check
  misses the last two. Planning notes stay gitignored.

CHECKLIST

  Nothing a mid dev or agent already knows
  One mode, one topic per doc
  One owner per topic; duplicates are links
  Reachable from the README.md Docs section, or intentionally gitignored
  No dead relative links
  Numbers and commands match the canonical source
  Reviewer treats undocumented new surface as a defect

BOUNDARIES: docs/commands.md / docs/configuration.md plus the spur skill
own command and config field semantics; SKILL.md, agent definitions,
AGENTS.md/CLAUDE.md prose belong to skill-writer.
