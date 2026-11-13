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
                    approval message and scope; Telegram delivery evidence or none: no channel
  *.html           local preview when used

APPROVAL

  Ask approval in current session chat; typed reply there is approval. Mirror to authorized session Telegram only when session has Telegram; follow agent-protocol.md.
  Request is screenshot plus one-line request, never prose current -> proposed restatement.
  Session has Telegram: attach screenshot to Telegram through `telegram` skill, never substitute a link; route text/buttons and screenshot to one authorized recipient.
  Missing channel never blocks.
  Reuse prior approval matching scope; still save screenshot proof, send it when session has Telegram.
  Return APPROVED or PENDING_APPROVAL; manager owns wait and revisions.
  Downstream agents read design-spec.md; changed scope needs matching approval.
