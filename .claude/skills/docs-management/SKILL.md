---
name: docs-management
description: Governs published docs (README.md, docs/, SETUP/TROUBLESHOOTING/CONTRIBUTING/SECURITY). Load on any published-doc edit — create, change, move, trim, or link fix. Enforces open-source standards: Diataxis mode, granular single-topic files, caveman prose, one source per topic, link don't restate. Not for README ## Config/## Commands field semantics (config-doc rule + spur skill) or SKILL.md/agent prose (skill-writer).
---

# Docs Management

Root README is reference + hub (`## Docs` lists every published doc). How-tos under `docs/`. Load on any published-doc edit.

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
| How-to (one task) | `docs/install-from-source.md`, `TROUBLESHOOTING.md`, `SETUP.md` |
| Reference (commands, fields) | `README.md` `## Commands`, `## Config` |
| Explanation (why) | gitignored planning notes (not shipped) |

## One source, max references

- Each topic has one owning doc. Everything else links. Never restate.
- Commands and config fields: `README.md` `## Commands`/`## Config` only.
- Contradiction: pick the owner, delete the copy, link.

## New functionality

New command, flag, config field, source type, provider, or event is documented in the same change, in `README.md` `## Commands`/`## Config`. Reviewer treats undocumented new surface as a defect.

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

- Command and config field semantics: `README.md` `## Config`/`## Commands` plus the `spur` skill.
- SKILL.md, agent definitions, `AGENTS.md`/`CLAUDE.md` prose: `skill-writer`.
