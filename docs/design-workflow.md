# Design workflow (Claude Design pre-implementation gate)

Pre-implementation design gate in `$manager`: for visible `packages/web` UI, author a design first, get explicit user approval, then hand a runtime-neutral export to any coding agent (Claude/Codex/Cursor).

## Gate

- Trigger: task introduces or changes visible `packages/web` UI.
- Agent `design-author` runs before `architect`. Gate order and the approval hard-stop: `manager` skill.
- Export contract (bundle layout, `design-spec.md` sections, approval field): `design` skill — the owner, not restated here.
- Post-implementation UI review stays with `designer`; distinct role, unchanged.

## Claude Design integration

- Backend: Claude Design (claude.ai/design). Figma MCP is present but out of scope.
- Tool: `DesignSync` MCP (load via ToolSearch). Bundled skills `/design-login` (design scope), `/design-sync` (incremental component sync).
- A design is a design-system project (`PROJECT_TYPE_DESIGN_SYSTEM`). Content = self-contained HTML previews; cards indexed by each preview's first-line `<!-- @dsCard group="..." -->`. Reuse project "Spur Design System".
- Verified: `DesignSync list_projects` works in the main Claude session, scopes granted. A Task subagent does NOT inherit `DesignSync` — authoring runs in a main Claude session; a subagent or non-Claude runtime is consume-only.

## Why runtime-neutral

Claude Design tools are Claude-only, so authoring is Claude-only. Coding must stay agent-agnostic. Bridge: export the design as plain local files (HTML previews + markdown spec) any agent reads without Claude Design tools. That bundle at `$SPUR_SESSION_ARTIFACTS_DIR/design/` is the contract, not the claude.ai project.

## Open questions (build carefully)

- Authoring host: `DesignSync` works only in the main session, but `manager` is a pure delegator that never acts, and Task subagents can't reach `DesignSync` — so nothing can currently author. Resolve before relying on the gate: let the manager run the design step inline, add a main-session design worker, or route design to a dedicated Claude session.
- Cross-session handoff: `$SPUR_SESSION_ARTIFACTS_DIR` is session-scoped. Fine within one task/session; a different runtime session picking up the coding work needs a shared path or a committed `design-spec.md`.
- Approval is an orchestration rule, not runtime-enforced. Mitigate: manager rule + Telegram ping + await-input.
