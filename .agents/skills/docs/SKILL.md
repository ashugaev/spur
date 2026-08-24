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

COMPACT, HARD

  One fact per line. Word over clause, clause over sentence, sentence
  over paragraph.
  Second pass on every block you touch: cut 30% of the words, lose zero
  facts. Merge two sentences sharing a subject.
  Paragraph over 4 lines: split into a `-` list or drop the narration.
  Word bans are the CAVEMAN, HARD list in `skill-writer` — hedge, degree,
  meta, justifying, transition, courtesy. One hit is a defect.
  Compression never drops a default, a limit, a field name, or an event
  name. Numbers and identifiers stay byte-exact.

SCOPE: document the interface, never the change

  Document user-facing surface: command, flag, config field, source type,
  event, provider, API route, install/deploy/CLI behavior.
  No doc edit for a refactor, an internal helper, a perf fix, or a bug fix
  that leaves the interface unchanged. Not every commit earns a doc line.
  State what a field does, its default, its constraint. Never why it was
  built, which design lost, or what the code does internally.
  Internal mechanism — cache keys, tick order, call chains, data shapes —
  stays in code, unless an operator acts on it.

GRANULAR: one doc, one topic, one Diataxis mode; split on drift.

  Tutorial (first run)          docs/install-from-npm.md
  How-to (one task)             docs/install-from-source.md, docs/voice.md,
                                 TROUBLESHOOTING.md, SETUP.md
  Reference (commands, fields)  docs/commands.md, docs/configuration.md
  Explanation (why)             gitignored planning notes, not shipped

ONE SOURCE: each topic has one owning doc, everything else links.

  - Commands: docs/commands.md only. Config fields: docs/configuration.md only.
  - Contradiction: pick the owner, delete the copy, link.

LINK GRAPH: every published doc reachable from the README Docs section, relative links only.

  Rename or move updates every inbound reference: markdown links, the .claude/.agents
  skill trees, CI path filters in .github/workflows/*.yml — link check
  misses the last two. Planning notes stay gitignored.

CHECKLIST

  - Nothing a mid dev or agent already knows
  - No interface change, no doc change
  - Second compression pass done
  - One mode, one topic per doc
  - One owner per topic; duplicates are links
  - Reachable from the README.md Docs section, or intentionally gitignored
  - No dead relative links
  - Numbers and commands match the canonical source
  - Reviewer treats undocumented new surface as a defect

BOUNDARIES: docs/commands.md / docs/configuration.md plus the spur skill
own command and config field semantics; SKILL.md, agent definitions,
AGENTS.md/CLAUDE.md prose belong to skill-writer.
