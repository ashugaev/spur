---
name: design
description: Author and export a UI design via Claude Design (claude.ai/design) for the pre-implementation design gate. Load when producing/exporting a design or defining the export contract. Covers DesignSync usage, the export bundle, and the approval protocol.
---

# Design

This skill is the authoritative export contract. For workflow rationale and gate wiring, see `docs/design-workflow.md`.

## DesignSync flow

- Tool: `DesignSync` (loaded via ToolSearch). Order: list/read -> `finalize_plan` -> write/delete.
- Bundled skills (Claude runtime, not in this repo): `/design-login` bootstraps design-system scope; `/design-sync` drives incremental local<->project sync, one component at a time — never wholesale replace.
- Reuse the existing design-system project "Spur Design System"; update components incrementally, don't create new projects per task.

## Export contract

Location: `$SPUR_SESSION_ARTIFACTS_DIR/design/` — session-scoped, renders inline in Spur UI, not committed from the worktree.

| File | Contents |
|---|---|
| `design-spec.md` | Handoff doc, see below |
| `*.html` (one or more) | Self-contained component previews, first line `<!-- @dsCard group="..." -->`, renderable inline in Spur UI and readable by any agent |

`design-spec.md` sections:
- Design summary
- Claude Design project (name + URL)
- Components: each with states + variants
- Design tokens: reference `packages/web` tokens by name, no hardcoded HEX/RGB (`frontend-codestyle` skill)
- Layout / responsive notes
- UI states: loading, empty, error, disabled, focus
- Acceptance criteria: visual, testable
- Approval status: `pending` | `approved by user @ <ISO-timestamp>`

## Approval protocol

`design-author` exports and returns `PENDING_APPROVAL` — it never waits on the user itself. The manager owns the hard-stop: ping the user with the project URL + summary, await input, and only resume architect/developer once `design-spec.md` approval status flips to `approved`.

Handoff: architect, developer, and designer read `design-spec.md` directly from the known path above and honor its Approval status field — no dependency on curator or task-memory. On Tier 2/3, curator may additionally note an "Accepted design" entry in `task-memory.md`.
