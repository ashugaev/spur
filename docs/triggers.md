# Triggers

Triggers are event-driven session spawners. When an event fires, the trigger spawns an agent session with a configured prompt or skill.

## Config

Triggers live under `projects.<id>.triggers` in `agent-orchestrator.yaml`:

```yaml
projects:
  my-app:
    repo: org/my-app
    path: ~/my-app
    triggers:
      daily-review:
        event: cron:tick
        schedule: "0 9 * * 1-5"
        spawn:
          prompt: "Review all open PRs"
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `event` | yes | Event source name. Currently supported: `cron:tick` |
| `schedule` | yes (for cron:tick) | Standard 5-field cron expression |
| `spawn` | yes | What session to create |
| `spawn.prompt` | one of prompt/skill | Prompt text sent to the agent |
| `spawn.skill` | one of prompt/skill | Skill name — agent receives `/<skill>` as prompt |
| `spawn.agent` | no | Override the project's default agent |
| `spawn.branch` | no | Override the project's default branch |
| `runOnStart` | no | Run immediately on `ao start` (default: `false`) |

### Cron expressions

Standard 5-field format: `minute hour day-of-month month day-of-week`

```
*     *     *     *     *
│     │     │     │     │
│     │     │     │     └── Day of week (0-7, Sun=0 or 7)
│     │     │     └──────── Month (1-12)
│     │     └────────────── Day of month (1-31)
│     └──────────────────── Hour (0-23)
└────────────────────────── Minute (0-59)
```

Examples:
- `0 9 * * 1-5` — 9am weekdays
- `0 * * * *` — every hour
- `*/30 * * * *` — every 30 minutes
- `0 2 * * *` — daily at 2am
- `0 0 1 * *` — first day of each month at midnight

Times are in the system's local timezone.

## Variations

### Prompt-based trigger

```yaml
triggers:
  nightly-audit:
    event: cron:tick
    schedule: "0 2 * * *"
    spawn:
      prompt: |
        Run a security audit. Check for OWASP top 10.
        Create a report at docs/security-audit.md.
```

### Skill-based trigger

```yaml
triggers:
  find-cars:
    event: cron:tick
    schedule: "0 * * * *"
    spawn:
      skill: find-cars    # agent receives "/find-cars"
```

Skills are loaded from `.claude/skills/` or `.agents/skills/`. The `skill` field takes precedence over `prompt` when both are set.

### With agent and branch overrides

```yaml
triggers:
  codex-review:
    event: cron:tick
    schedule: "0 9 * * 1-5"
    spawn:
      prompt: "Review all open PRs"
      agent: codex
      branch: main
```

### Run on start

```yaml
triggers:
  health-check:
    event: cron:tick
    schedule: "*/30 * * * *"
    runOnStart: true          # fires immediately + on schedule
    spawn:
      prompt: "Check system health"
```

## Cron-only projects

Projects that only use triggers (no coding, no git) can omit `repo` and `path`:

```yaml
projects:
  my-automations:
    name: My Automations
    # No repo or path — scratch dir created automatically
    triggers:
      find-cars:
        event: cron:tick
        schedule: "0 * * * *"
        spawn:
          skill: find-cars
      daily-report:
        event: cron:tick
        schedule: "0 9 * * *"
        spawn:
          prompt: "Check stats and send summary to Telegram"
```

When `path` is omitted, a scratch directory is created at `~/.agent-orchestrator/scratch/<project-id>`. No git worktree is created — the agent runs directly in the scratch dir.

## How it works

1. `ao start` reads `triggers` from each project config
2. For each `cron:tick` trigger, a cron job is scheduled using the `schedule` expression
3. When the cron fires, `sessionManager.spawn()` is called with the configured prompt/skill/agent/branch
4. The agent session runs in tmux like any other session
5. `ao stop` cleans up all cron jobs

Triggers are shown in the dashboard under the **Cron Jobs** tab per project.

## Listeners vs Triggers

| | Listeners | Triggers |
|---|---|---|
| Purpose | Poll-based tracker integrations | Event-driven session spawning |
| Config key | `listeners` | `triggers` |
| Sources | `tracker-task` | `cron:tick` (more planned) |
| Scheduling | `intervalMs` (milliseconds) | `schedule` (cron expression) |
| Use case | Watch Jira/Linear for tasks | Run agents on a schedule |
