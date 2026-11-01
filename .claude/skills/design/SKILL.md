---
name: design
description: Prepare proposed UI screenshots and approval evidence before visible packages/web changes. Use when producing UI previews or defining their handoff contract.
---

DESIGN: screenshot contract; workflow in docs/design-workflow.md.

PREVIEW

  Render proposed UI in isolated sidecar or local HTML preview, any runtime.
  Load frontend-codestyle; use existing components and tokens.
  Save screenshot before dependent implementation; preview code stays in artifacts.

HANDOFF: $SPUR_SESSION_ARTIFACTS_DIR/design/, never committed.

  proposed-ui.png   screenshot of changed components and affected states
  design-spec.md    current -> proposed behavior; screenshot paths;
                    components/states; acceptance criteria;
                    Approval status: pending | approved by user @ <ISO>;
                    approval message and scope; Telegram delivery evidence
  *.html           local preview when used

APPROVAL

  Mirror current -> proposed change and approval request in current channel
  and authorized session Telegram; follow agent-protocol.md.
  Attach screenshot to Telegram through `telegram` skill; never substitute a link.
  Route text/buttons and screenshot to one authorized recipient per `telegram` skill.
  Reuse prior approval matching scope; still save and send screenshot proof.
  Return APPROVED or PENDING_APPROVAL; manager owns wait and revisions.
  Downstream agents read design-spec.md; changed scope needs matching approval.
