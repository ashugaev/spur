# Design workflow (Claude Design pre-implementation gate)

> Scope: Claude Design workflow and export contract. Caveman, no overhead.

Pre-implementation design gate in `$manager`: for visible `packages/web` UI, author a design first, get explicit user approval, then hand a runtime-neutral export to any coding agent (Claude/Codex/Cursor).

## Gate

- Trigger: task introduces or changes visible `packages/web` UI.
- The manager runs the `design-author` process in the main Claude session with the Artifact tool before `architect`. Gate order and approval hard-stop: `manager` skill.
- Export contract (bundle layout, `design-spec.md` sections, approval field): `design` skill — the owner, not restated here.
- Post-implementation UI review stays with `designer`; distinct role, unchanged.

## Claude Design integration

- Backend: Claude Design (claude.ai/design). Figma MCP is present but out of scope.
- Author with the Artifact tool: Artifact quickstart `intent=design` creates a Design canvas. Update task components only.
- `DesignSync` reads and syncs design-system projects; its tool contract forbids design authoring. No project name is required for the canvas.
- Run `/design-login` if design scope is missing. A non-Claude runtime consumes the approved local export.

## Why runtime-neutral

Claude Design authoring runs in Claude. Export plain local files (HTML previews + markdown spec) for coding agents. The bundle at `$SPUR_SESSION_ARTIFACTS_DIR/design/` is the contract.

## Open questions (build carefully)

- Cross-session handoff: `$SPUR_SESSION_ARTIFACTS_DIR` is session-scoped. Fine within one task/session; a different runtime session picking up the coding work needs a shared path or a committed `design-spec.md`.
- Approval is an orchestration rule, not runtime-enforced. Mitigate: manager rule + Telegram ping + await-input.
