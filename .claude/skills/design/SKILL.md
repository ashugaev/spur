---
name: design
description: Prepare proposed UI screenshots and approval evidence before visible packages/web changes. Use when producing UI previews or defining their handoff contract.
---

DESIGN: workflow in docs/design-workflow.md.

COMPLETENESS: before implementation, including imported Claude Design.

  Compare current product/code with design; map scenarios/states to design coverage in design-spec.md.
  Cover conditions, transitions, dependencies, errors, loading, empty, disabled, variants and responsive layouts.
  Send gaps to design agent for revision and user as missing-behavior report.
  Recheck revisions before implementation; never silently remove or invent behavior.

PREVIEW

  Load design-system and supplied design system; check tokens, components, typography, layout and states.
  Report conflicts between supplied system and repository rules; never choose silently.
  Render with existing components/tokens in isolated sidecar or local HTML.
  Save screenshot before implementation; keep preview code in artifacts.

CONTRAST: every action and label, both themes.

  Measure rendered/computed colors against composited backgrounds, including images/overlays.
  Thresholds and token fixes: design-system references/contrast.md.
  Fix failures before handoff.

HANDOFF: $SPUR_SESSION_ARTIFACTS_DIR/design/, never committed.

  proposed-ui.png   changed components/states at phone, iPad mini and desktop widths (design-system patterns.md TARGET SIZES)
  design-spec.md    before/after; screenshots; components/states; acceptance;
                    Approval status: pending or approved by user @ <ISO>;
                    approval message/scope; Telegram evidence or none: no channel
  *.html           preview

APPROVAL

  Ask in session chat: screenshot plus one line, no before/after restatement; typed reply counts.
  Mirror through `telegram` to authorized recipient when connected: attach screenshot, never substitute link; follow agent-protocol.md.
  Missing channel never blocks; matching prior approval counts, screenshot capture/delivery still required.
  Return APPROVED or PENDING_APPROVAL; manager owns wait/revisions.
  Downstream agents read design-spec.md; scope changes require matching approval.
