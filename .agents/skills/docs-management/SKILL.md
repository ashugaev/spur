---
name: docs-management
description: Organize and edit published documentation using the Diataxis framework. Use when a task creates, moves, consolidates, or trims docs under docs/ or the root doc files (README.md, SETUP.md, TROUBLESHOOTING.md, CONTRIBUTING.md), or fixes doc navigation and links. Don't use for the README.md Config/Commands reference semantics (owned by the config-doc rule and the spur skill) or for SKILL.md and agent-definition prose (skill-writer).
---

# Docs Management

Root `README.md` is the canonical reference and the doc hub. Its `## Docs` section links every published doc. Task-specific how-tos live under `docs/`; contributor and operator docs live at repo root.

## Diataxis mode

Each doc serves one mode. Pick one; do not mix. Reference tables inside a how-to, or rationale inside a reference, is the most common defect.

| Mode | Answers | Owner |
|---|---|---|
| Tutorial | Run Spur the first time | `docs/install-from-npm.md` |
| How-to | Do one specific task | `docs/install-from-source.md`, `TROUBLESHOOTING.md`, `SETUP.md` |
| Reference | Exact commands, fields, values, ports | `README.md` `## Commands`, `## Config` |
| Explanation | Why it works this way | planning notes, gitignored and local-only (not in the shipped tree) |

## Document new functionality

- New user-facing surface is documented in the same change that ships it: a command in `README.md` `## Commands`, a flag on its command, a config field or source type or provider or event in `## Config`. Reviewer treats undocumented new functionality as a defect.
- Expanding the reference is part of the change, not a follow-up. The most common drift is code that adds a command/flag/field the reference never lists.

## One source of truth

- Each topic has one owning doc. Others link to it. Never restate.
- Commands and config fields: `README.md` `## Commands`/`## Config` only. Install and deploy how-tos point there, never re-document the reference.
- Two docs contradict: pick the owner, delete the copy, link.

## Minimalism

- Replace restated prose with a link plus one line of context.
- No marketing, no future-tense promises, no "as mentioned above".
- Migration notes age out. Drop them once the release they bridge is old.
- Uniform structure becomes a table, not paragraphs.

## Link graph

- Every published doc linked from `README.md` `## Docs`.
- Planning and internal notes stay gitignored and local-only, out of the published tree on purpose.
- Relative links only. Renaming or moving a doc updates every inbound reference in the same change: markdown links, the `.claude/` and `.agents/` skill trees, and CI path filters in `.github/workflows/*.yml`. A link check catches the first, not the last.

## Procedure

1. Classify the doc by mode. Wrong mode: split or move the content.
2. Find the owner of each topic it covers. Not the owner: replace the section with a link.
3. Trim to the shortest form that stays correct.
4. Link from `README.md` `## Docs` unless intentionally local-only.
5. Verify every relative link resolves.

## Checklist

- [ ] One Diataxis mode per doc
- [ ] Single owner per topic; duplicates replaced by links
- [ ] Reachable from `README.md` `## Docs`, or intentionally gitignored
- [ ] No dead relative links
- [ ] Numbers and commands match the canonical source
- [ ] No stale version or migration references

## Boundaries

- Command and config field semantics: `README.md` `## Commands`/`## Config` plus the `spur` skill.
- SKILL.md, agent definitions, `AGENTS.md`/`CLAUDE.md` prose: `skill-writer`.
