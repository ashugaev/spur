---
name: design
description: Author and export a UI design via Claude Design (claude.ai/design) for the pre-implementation design gate. Load when producing/exporting a design or defining the export contract. Covers Artifact authoring, the export bundle, and the approval protocol.
---

DESIGN: export contract, rationale + gate wiring in docs/design-workflow.md.

AUTHORING: use Artifact tool in main Claude session. Start a Design canvas
with Artifact quickstart intent=design; update only task components.
DesignSync reads and syncs design-system projects; never author designs
through DesignSync. /design-login grants design scope when missing.

EXPORT BUNDLE: $SPUR_SESSION_ARTIFACTS_DIR/design/, session-scoped, renders inline in Spur UI, not committed.

  design-spec.md   handoff doc, see below
  *.html           self-contained preview, first line
                    <!-- @dsCard group="..." -->

design-spec.md: summary; canvas name+URL; components (states+variants);
tokens (packages/web names, no hardcoded HEX, frontend-codestyle);
layout/responsive; UI states (loading/empty/error/disabled/focus);
acceptance criteria (visual, testable); approval status (pending |
approved by user @ <ISO>).

APPROVAL: design-author exports, returns PENDING_APPROVAL, never waits.
Manager hard-stops, pings user with canvas URL + summary, resumes when
approval status is approved. Downstream (architect, developer, designer)
read design-spec.md and honor it; Tier 2/3 curator optionally notes
"Accepted design" in task-memory.md.
