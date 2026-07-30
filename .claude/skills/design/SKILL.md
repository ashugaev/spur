---
name: design
description: Author and export a UI design via Claude Design (claude.ai/design) for the pre-implementation design gate. Load when producing/exporting a design or defining the export contract. Covers DesignSync usage, the export bundle, and the approval protocol.
---

# Design

Authoritative export contract. Rationale + gate wiring: `docs/design-workflow.md` (edit it under the `docs` skill).

## DesignSync

- Tool `DesignSync`, load via `ToolSearch(select:DesignSync)`. Order: list/read -> `finalize_plan` -> write/delete.
- Claude runtime, main session only — a Task subagent does not inherit it (verified). Bundled skills: `/design-login` grants design scope; `/design-sync` syncs local<->project one component at a time, never wholesale.
- Reuse project "Spur Design System". Update components incrementally; never one project per task.

## Export bundle

`$SPUR_SESSION_ARTIFACTS_DIR/design/` — session-scoped, renders inline in Spur UI, not committed.

| File | Contents |
|---|---|
| `design-spec.md` | Handoff doc (below) |
| `*.html` | Self-contained previews, first line `<!-- @dsCard group="..." -->`, readable by any agent |

`design-spec.md`: summary; project name + URL; components (states + variants); tokens (reference `packages/web` names, no hardcoded HEX — `frontend-codestyle`); layout/responsive; UI states (loading/empty/error/disabled/focus); acceptance criteria (visual, testable); approval status (`pending` | `approved by user @ <ISO>`).

## Approval

`design-author` exports, returns `PENDING_APPROVAL`, never waits itself. Manager hard-stops: ping user with project URL + summary, await input, resume only when approval status is `approved`.

Downstream (architect, developer, designer) read `design-spec.md` from the path above and honor its approval status — no curator dependency. Tier 2/3: curator may add an "Accepted design" note in `task-memory.md`.
