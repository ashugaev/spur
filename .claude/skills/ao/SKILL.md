---
name: ao
description: Agent Orchestrator (ao) assistant. Use when working with ao CLI, config, sessions, plugins, lifecycle, reactions, or any AO feature. Knows all capabilities and always delegates implementation to agents via task/PR/prompt — never writes code directly.
---

# Agent Orchestrator (ao) Skill

## CRITICAL RULE: No Direct Code Writing

**This skill NEVER writes code directly.** All implementation tasks must be delegated to an agent by:
- Assigning a GitHub issue/PR to an `ao spawn` session
- Writing a detailed prompt and sending it via `ao send`
- Describing the task clearly so the agent can execute it autonomously

Your role: understand what needs to be done, identify the right session/issue, compose the prompt, and delegate.

---

## What is Agent Orchestrator?

Open-source system for orchestrating parallel AI coding agents. Spawn agents on issues, walk away, get notified when your judgment is needed.

**Core principle: Push, not pull.**

---

## CLI Commands Reference

### Setup & Init

```bash
ao init                          # Interactive setup wizard (detects git, tmux, gh, env keys)
```

### Spawning Sessions

```bash
ao spawn <project> [issue] [--open] [--agent <name>]
# Example: ao spawn my-app INT-123 --open
# Example: ao spawn my-app --agent codex

ao batch-spawn <project> <issues...> [--open]
# Example: ao batch-spawn my-app INT-1 INT-2 INT-3
# Detects duplicates, skips closed issues, 500ms delay between spawns
```

### Session Management

```bash
ao session ls [-p <project>]           # List all active sessions
ao session kill <session>              # Kill session + remove worktree
ao session restore <session>           # Restore killed/crashed session
ao session cleanup [-p <project>] [--dry-run]  # Auto-kill merged/closed sessions
```

### Communicating with Agents

```bash
ao send <session> [message...] [options]
# Options:
#   -f <file>          Send file contents
#   --no-wait          Don't wait for agent idle
#   --timeout <secs>   Max wait seconds (default: 600)
# Example: ao send my-app-1 "Run the tests and fix any failures"
```

### Orchestrator Lifecycle

```bash
ao start [project] [url]   # Start lifecycle manager + event polling
ao stop [project]          # Stop lifecycle manager
ao restart [project]       # Restart lifecycle manager
```

### Dashboard

```bash
ao dashboard [--port <port>] [--no-open] [--rebuild]
# Starts Next.js on port 3000, opens browser, shows Tailscale URL
```

### Status & Review

```bash
ao status [-p <project>] [--json]      # Full session state table
ao review-check [project] [--dry-run]  # Check PRs for review comments, auto-reply
ao open [target] [--new-window]        # Open sessions in iTerm2
ao source-reply <session> [message]    # Reply to inbound Telegram/Jira messages
```

---

## Configuration (agent-orchestrator.yaml)

### Top-level Keys

```yaml
dataDir: ~/.agent-orchestrator          # Session metadata storage
worktreeDir: ~/.worktrees               # Git worktrees location
port: 3000                              # Dashboard port
terminalPort: 14800
directTerminalPort: 14801
readyThresholdMs: 300000                # 5min → idle/stuck threshold

defaults:
  runtime: tmux                         # tmux | process | docker | kubernetes
  agent: claude-code                    # claude-code | codex | aider | opencode | cursor
  workspace: worktree                   # worktree | clone | copy
  notifiers: [desktop]                  # desktop | slack | telegram | webhook | composio

remote:
  tailscaleHost: auto                   # Tailscale MagicDNS
```

### Project Config

```yaml
projects:
  my-app:
    name: My App
    repo: org/repo                      # GitHub owner/repo
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app                  # app-1, app-2, ...

    tracker:
      plugin: linear                    # linear | github | jira
      teamId: "team-id"                 # Linear-specific

    runtime: tmux                       # Override defaults
    agent: codex
    workspace: worktree

    symlinks: [.env, .claude]           # Symlink into worktrees
    postCreate:                         # Run after workspace creation
      - pnpm install

    agentConfig:
      permissions: skip                 # skip | default
      model: opus

    agentRules: |                       # Inline agent instructions
      Always run tests before pushing.
    agentRulesFile: .agent-rules.md     # Alternative: file path

    reactions:                          # Per-project overrides
      approved-and-green:
        auto: true
        action: auto-merge
        mergeMethod: squash
```

### Reactions (Auto-Response Rules)

```yaml
reactions:
  ci-failed:
    auto: true
    action: send-to-agent               # send-to-agent | notify | auto-merge
    message: "CI failed. Fix and push."
    retries: 2
    escalateAfter: 2                    # After N failures OR duration like "30m"
    priority: warning                   # urgent | action | warning | info

  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m

  merge-conflicts:
    auto: true
    action: send-to-agent
    message: "Rebase on main, resolve conflicts, run tests, push."
    escalateAfter: 15m

  approved-and-green:
    auto: false                         # true = auto-merge
    action: auto-merge
    mergeMethod: squash                 # merge | squash | rebase
    priority: action

  agent-stuck:
    threshold: 10m
    action: notify
    priority: urgent
```

### Notifiers

```yaml
notifiers:
  slack:
    plugin: slack
    webhook: ${SLACK_WEBHOOK_URL}
    channel: "#agent-updates"

  telegram:
    plugin: telegram
    botToken: ${AO_TELEGRAM_BOT_TOKEN}
    chatId: ${AO_TELEGRAM_CHAT_ID}
    webhookSecret: ${AO_TELEGRAM_WEBHOOK_SECRET}
    pollingIntervalMs: 30000

  desktop:
    plugin: desktop

  webhook:
    plugin: webhook
    url: https://example.com/webhooks/ao

notificationRouting:
  urgent: [desktop, telegram]           # agent stuck, errored
  action: [desktop, telegram]           # PR ready to merge
  warning: [telegram]                   # auto-fix failed
  info: [telegram]                      # summary, done
```

### Listeners (Auto-spawn from backlog)

```yaml
listeners:
  jira-backlog:
    enabled: true
    source: jira-backlog
    projectId: my-app
    intervalMs: 60000
    jql: 'assignee = "user@example.com" AND labels = "AutoSpawn"'
    backlogStatus: "Backlog"
    lockStaleMs: 300000
    trigger:
      type: spawn-session
      agent: codex
```

### Services

```yaml
services:
  transcriber:
    plugin: whisper-cpp
    binaryPath: /opt/whisper.cpp/build/bin/whisper-cli
    modelPath: /opt/whisper.cpp/models/ggml-base.bin
    language: en
```

---

## Plugin Architecture

8 swappable plugin slots, all interfaces in `packages/core/src/types.ts`:

| Slot | Interface | Default | Alternatives |
|------|-----------|---------|--------------|
| Runtime | `Runtime` | tmux | process, docker, k8s |
| Agent | `Agent` | claude-code | codex, aider, opencode, cursor |
| Workspace | `Workspace` | worktree | clone, copy |
| Tracker | `Tracker` | github | linear, jira |
| SCM | `SCM` | github | — |
| Notifier | `Notifier` | desktop | slack, telegram, webhook, composio |
| Terminal | `Terminal` | iterm2 | web |
| Lifecycle | (core) | — | — |

### Key Plugin Capabilities

**SCM (GitHub):**
- PR lifecycle: detect, get state, merge, close
- CI: individual checks, overall status (pending | passing | failing | none)
- Reviews: get reviews, decision (approved | changes_requested | pending | none)
- Comments: pending unresolved threads, automated bot comments
- Mergeability: mergeable, ciPassing, approved, noConflicts, blockers

**Tracker:**
- getIssue, isCompleted, branchName, generatePrompt
- listIssues (with filters), updateIssue, createIssue

**Agent:**
- Activity states: active | ready | idle | waiting_input | blocked | exited
- detectActivity (from terminal output), getActivityState (native)
- Cost tracking: inputTokens, outputTokens, estimatedCostUsd
- Session resume support

---

## Session Lifecycle

```
spawning → working → pr_open → ci_failed → review_pending →
changes_requested → approved → mergeable → merged → cleanup → done

Error paths:
- killed (manual kill)
- terminated (system)
- errored (crash)
- needs_input (agent waiting for human)
- stuck (idle > threshold)
```

---

## Web API (packages/web)

```
GET  /api/sessions              # List sessions (?active=true, ?projectId=x)
POST /api/spawn                 # Spawn session { projectId, issueId? }
GET  /api/sessions/:id          # Get session
POST /api/sessions/:id/send     # Send message { message }
POST /api/sessions/:id/kill     # Kill session
POST /api/sessions/:id/restore  # Restore session
POST /api/prs/:id/merge         # Merge PR
GET  /api/events                # SSE stream (snapshots + heartbeat every 15s)
POST /api/integrations/telegram # Telegram webhook
GET  /api/integrations/status   # Integration health check
GET  /api/jira/sprint-tasks     # List sprint tasks
```

---

## Storage

- Session metadata: `~/.agent-orchestrator/<project>/<session-id>` (flat key=value)
- Event log: `~/.agent-orchestrator/events.jsonl` (JSONL, append-only)
- Runtime state: `.ao-start-runtime.json` in working dir (auto-cleaned on stop)

---

## Common Workflows

### Spawn agent on a ticket
```bash
ao spawn my-app INT-123 --open
```

### Batch spawn sprint tickets
```bash
ao batch-spawn my-app INT-1 INT-2 INT-5 INT-8
```

### Check what's happening
```bash
ao status
ao status --json | jq '.[] | select(.status == "ci_failed")'
```

### Send instructions to an agent
```bash
ao send my-app-1 "The tests in packages/core are failing. Run pnpm test, read the errors, fix them."
```

### Handle review comments
```bash
ao review-check                    # Auto-send review comments to agents
ao review-check --dry-run          # Preview without sending
```

### Auto-merge approved PRs
```bash
# In config: reactions.approved-and-green.auto: true
# Or manually via dashboard POST /api/prs/:id/merge
```

### Clean up merged sessions
```bash
ao session cleanup --dry-run       # Preview
ao session cleanup                 # Execute
```

### Full restart
```bash
ao restart
```

---

## How to Delegate Tasks (Core Rule)

When the user asks to implement, fix, or build something in this repo:

1. **Understand the task** — read relevant code, understand the context
2. **Identify the right session or create one**:
   ```bash
   ao session ls                              # Check existing sessions
   ao spawn agent-orchestrator --open         # Or spawn a new one
   ```
3. **Compose a precise prompt** with:
   - What to implement/fix
   - Which files to touch
   - What tests to run
   - How to verify success
4. **Send the prompt**:
   ```bash
   ao send <session> "<detailed prompt>"
   ```
5. **Monitor**:
   ```bash
   ao status
   # Wait for notification when done or needs input
   ```

Never write code yourself — always delegate to an agent session.
