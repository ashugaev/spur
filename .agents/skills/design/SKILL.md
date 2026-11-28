---
name: design
description: Prepare proposed UI screenshots and approval evidence before visible packages/web changes. Use when producing UI previews or defining their handoff contract.
---

DESIGN: screenshot contract; workflow in docs/design-workflow.md.

PREVIEW

  Render proposed UI in isolated sidecar or local HTML preview, any runtime.
  Load design-system; use existing components and tokens.
  Save screenshot before dependent implementation; preview code stays in artifacts.

CONTRAST: every actionable element (button, icon, link, control) and its label.

  Background: surface it renders on, incl. images, translucent and overlay layers, both themes.
  Thresholds and token fixes: design-system references/contrast.md.
  Measure rendered pixels or computed colors, never token names.
  Fail: fix before handoff.

HANDOFF: $SPUR_SESSION_ARTIFACTS_DIR/design/, never committed.

  proposed-ui.png   screenshot of changed components and affected states, at phone, iPad mini and desktop widths (design-system patterns.md TARGET SIZES)
  design-spec.md    current -> proposed behavior; screenshot paths;
                    components/states; acceptance criteria;
                    Approval status: pending | approved by user @ <ISO>;
                    approval message and scope; Telegram delivery evidence or unavailable
  *.html           local preview when used

APPROVAL

  Ask approval in current session chat; typed reply there is approval. Mirror through available Telegram per agent-protocol.md.
  Request is screenshot plus one-line request, never prose current -> proposed restatement.
  Telegram mirror: attach screenshot through `telegram` skill, never substitute a link; route request and screenshot to one authorized recipient.
  Absent or failed Telegram: continue approval in current chat only.
  Reuse prior approval matching scope; still save screenshot proof.
  Return APPROVED or PENDING_APPROVAL; manager owns wait and revisions.
  Downstream agents read design-spec.md; changed scope needs matching approval.
