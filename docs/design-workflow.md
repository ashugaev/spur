# Approve proposed UI

Use for visible `packages/web` changes, in any agent runtime.

1. Render proposed components and affected states in an isolated sidecar or local HTML preview.
2. Save screenshot and approval handoff to `$SPUR_SESSION_ARTIFACTS_DIR/design/` per [design skill](../.agents/skills/design/SKILL.md).
3. Send screenshot as an image attachment to authorized session Telegram through [telegram skill](../.agents/skills/telegram/SKILL.md).
4. Present current → proposed change and approval request here and in Telegram; use [source reply](commands.md#source-reply) for text/buttons.
5. Record matching user approval before dependent implementation. Prior approval covering scope counts; screenshot proof still required.

Keep preview code in artifacts. Follow [frontend-codestyle](../.agents/skills/frontend-codestyle/SKILL.md) for components and tokens.

Route approval and gate order through [manager](../.agents/skills/manager/SKILL.md) and [agent protocol](../.agents/skills/github/references/agent-protocol.md). Review implemented UI through `designer`.

At a stop, name exact blocker, rule/tool source, current → proposed change and required action in 2–3 lines. Continue independent work while awaiting approval.
