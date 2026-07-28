---
name: docs
description: Governs published docs (README.md, docs/, SETUP/TROUBLESHOOTING/CONTRIBUTING/SECURITY). Load on any published-doc edit — create, change, move, trim, or link fix. Enforces open-source standards: Diataxis mode, granular single-topic files, caveman prose, one source per topic, link don't restate. Not for config/command field semantics (docs/configuration.md + docs/commands.md, owned by the config-doc rule and spur skill) or SKILL.md/agent prose (skill-writer).
---

# Docs Management

Root README is a minimal hub — `## Docs` lists every published doc, plus the AI-agent install prompt. Reference lives in `docs/`. Load on any published-doc edit.

## Write caveman

- Only the non-obvious. Cut what a mid dev or agent already knows or trivially finds (`npm`, `systemd`, `git`, `nginx` basics).
- State the gotcha; skip the obvious step.
- No filler, hedging, self-narration ("as noted", "simply", "note that"), marketing, future promises, or time words ("now", "currently").
- Fragments OK. Imperative. One term per concept.

## Granular

One doc, one topic, one Diataxis mode. Split when a doc drifts across modes or topics.

| Mode | Owner |
|---|---|
| Tutorial (first run) | `docs/install-from-npm.md` |
| How-to (one task) | `docs/install-from-source.md`, `docs/voice.md`, `TROUBLESHOOTING.md`, `SETUP.md` |
| Reference (commands, fields) | `docs/commands.md`, `docs/configuration.md` |
| Explanation (why) | gitignored planning notes (not shipped) |

## One source, max references

- Each topic has one owning doc. Everything else links. Never restate.
- Commands: `docs/commands.md` only. Config fields: `docs/configuration.md` only.
- Contradiction: pick the owner, delete the copy, link.

## New functionality

New command, flag, config field, source type, provider, or event is documented in the same change — commands in `docs/commands.md`, config in `docs/configuration.md`. Reviewer treats undocumented new surface as a defect.

## Link graph

- Every published doc reachable from `README.md` `## Docs`.
- Relative links only. Rename or move updates every inbound reference in the same change: markdown links, the `.claude`/`.agents` skill trees, CI path filters in `.github/workflows/*.yml`. A link check misses the last two.
- Planning and internal notes stay gitignored, out of the published tree.

## Checklist

- [ ] Nothing a mid dev or agent already knows
- [ ] One mode, one topic per doc
- [ ] One owner per topic; duplicates are links
- [ ] Reachable from `README.md` `## Docs`, or intentionally gitignored
- [ ] No dead relative links
- [ ] Numbers and commands match the canonical source

## Boundaries

- Command and config field semantics: `docs/commands.md` / `docs/configuration.md` plus the `spur` skill.
- SKILL.md, agent definitions, `AGENTS.md`/`CLAUDE.md` prose: `skill-writer`.
