---
name: ao
description: Complete AO CLI reference — run any orchestrator command, manage sessions, and work with parallel agents.
---

# Agent Orchestrator (AO) — Complete CLI Reference

You are now the AO assistant. Help the user run any AO command, understand session state, and manage parallel AI coding agents.

## Quick Start

```bash
ao init                          # Interactive setup wizard
ao init --auto                   # Auto-generate config with smart defaults
ao start                         # Start orchestrator + dashboard for all projects
ao start <project>               # Start for a specific project
ao start <github-url>            # Clone repo, generate config, start
ao spawn <project> <issue>       # Spawn agent session for an issue
ao status                        # See all sessions with PR/CI/review status
```

---

## All Commands

### `ao init`
Interactive setup wizard — creates `agent-orchestrator.yaml`.

```bash
ao init                          # Interactive prompts
ao init --auto                   # Auto-generate with smart defaults (no prompts)
ao init --auto --smart           # Analyze project and generate custom rules
ao init -o custom-config.yaml    # Custom output path
```

**Options:**
- `-o, --output <path>` — Output file path (default: `agent-orchestrator.yaml`)
- `--auto` — Auto-generate config with sensible defaults (no prompts)
- `--smart` — Analyze project and generate custom rules (requires `--auto`)

**What it detects:** Git repo, remote, default branch, tmux, gh CLI auth, LINEAR_API_KEY, SLACK_WEBHOOK_URL, Telegram tokens.

---

### `ao start [project]`
Start orchestrator agent and dashboard. Can also onboard from a URL.

```bash
ao start                         # Start all projects
ao start my-app                  # Start specific project
ao start https://github.com/org/repo  # Clone + auto-config + start
ao start --no-dashboard          # Skip dashboard, only orchestrator agent
ao start --no-orchestrator       # Skip orchestrator agent, only dashboard
ao start --rebuild               # Clean and rebuild dashboard before starting
```

**Options:**
- `--no-dashboard` — Skip starting the dashboard server
- `--no-orchestrator` — Skip starting the orchestrator agent
- `--rebuild` — Clean stale build artifacts and rebuild

**What it does:**
1. Loads config (or clones repo + generates config for URL mode)
2. Starts Next.js dashboard on configured port (default 3000)
3. Creates orchestrator tmux session per project
4. Starts lifecycle polling (reactions, notifications)
5. Starts Telegram/Jira polling if configured
6. Opens browser to dashboard

---

### `ao stop [project]`
Stop orchestrator agent and dashboard.

```bash
ao stop                          # Stop (single project or specify)
ao stop my-app                   # Stop specific project
```

---

### `ao restart <project>`
Restart orchestrator agent and dashboard.

```bash
ao restart my-app
ao restart my-app --rebuild      # Clean dashboard cache before restart
```

**Options:**
- `--rebuild` — Clean and rebuild dashboard before starting

---

### `ao spawn <project> [issue]`
Spawn a single agent session.

```bash
ao spawn my-app                  # Spawn without issue
ao spawn my-app INT-1234         # Spawn for Linear issue
ao spawn my-app '#42'            # Spawn for GitHub issue #42
ao spawn my-app INT-1234 --open  # Spawn and open in terminal tab
ao spawn my-app INT-1234 --agent codex  # Use Codex instead of default agent
```

**Arguments:**
- `<project>` — Project ID from config (required)
- `[issue]` — Issue identifier, e.g. `INT-1234`, `#42` (must exist in tracker)

**Options:**
- `--open` — Open session in terminal tab (uses iTerm2 plugin)
- `--agent <name>` — Override the agent plugin (e.g. `codex`, `claude-code`, `aider`)

**What it does:**
1. Pre-flight checks (tmux available, gh auth if GitHub tracker)
2. Creates git worktree for isolation
3. Creates tmux session with agent running
4. Agent gets system prompt with issue context and project rules

---

### `ao batch-spawn <project> <issues...>`
Spawn sessions for multiple issues with duplicate detection.

```bash
ao batch-spawn my-app INT-1 INT-2 INT-3
ao batch-spawn my-app INT-1 INT-2 --open  # Open each in terminal tab
```

**Arguments:**
- `<project>` — Project ID from config (required)
- `<issues...>` — Space-separated issue identifiers (required)

**Options:**
- `--open` — Open sessions in terminal tabs

**Features:**
- Deduplicates issues within batch and against existing sessions
- Skips dead/killed sessions (allows respawning crashed sessions)
- Shows summary: created, skipped (duplicate), failed
- 500ms delay between spawns

---

### `ao status`
Show all sessions with branch, activity, PR, CI, and review status.

```bash
ao status                        # All projects
ao status -p my-app              # Filter by project
ao status --json                 # JSON output (for scripting)
```

**Options:**
- `-p, --project <id>` — Filter by project ID
- `--json` — Output as JSON

**Columns:** Session, Branch, PR#, CI status, Review decision, Unresolved threads, Activity state, Age.

**Fallback:** Without config, discovers tmux sessions directly.

---

### `ao send <session> [message...]`
Send a message to a session with busy detection and retry.

```bash
ao send ao-7 "Fix the failing test"
ao send ao-7 -f instructions.md       # Send file contents
ao send ao-7 --no-wait "urgent fix"   # Don't wait for idle
ao send ao-7 --timeout 300 "message"  # Custom timeout (seconds)
```

**Arguments:**
- `<session>` — Session name (required)
- `[message...]` — Message text (joined with spaces)

**Options:**
- `-f, --file <path>` — Send contents of a file instead
- `--no-wait` — Don't wait for session to become idle before sending
- `--timeout <seconds>` — Max seconds to wait for idle (default: 600)

**How it works:**
1. Waits for agent to become idle (polls tmux output every 5s)
2. Clears any partial input (Ctrl+U)
3. Sends message via tmux (uses load-buffer for long messages)
4. Presses Enter
5. Verifies delivery with 3 retries

---

### `ao session ls`
List all sessions with metadata.

```bash
ao session ls                    # All projects
ao session ls -p my-app          # Filter by project
```

**Options:**
- `-p, --project <id>` — Filter by project ID

---

### `ao session kill <session>`
Kill a session and remove its worktree.

```bash
ao session kill ao-7
```

---

### `ao session cleanup`
Kill sessions where PR is merged or issue is closed.

```bash
ao session cleanup               # All projects
ao session cleanup -p my-app     # Specific project
ao session cleanup --dry-run     # Preview without action
```

**Options:**
- `-p, --project <id>` — Filter by project ID
- `--dry-run` — Show what would be cleaned up without doing it

---

### `ao session restore <session>`
Restore a terminated/crashed session in-place.

```bash
ao session restore ao-7
```

Recreates the tmux session and agent in the existing worktree.

---

### `ao review-check [project]`
Check PRs for review comments and trigger agents to address them.

```bash
ao review-check                  # All projects
ao review-check my-app           # Specific project
ao review-check --dry-run        # Preview without sending messages
```

**Options:**
- `--dry-run` — Show what would be done without sending messages

**What it does:** For each session with a PR, checks for unresolved review threads and CHANGES_REQUESTED decisions. Sends fix prompt to agents via tmux.

---

### `ao dashboard`
Start the web dashboard standalone.

```bash
ao dashboard                     # Default port from config or 3000
ao dashboard -p 3001             # Custom port
ao dashboard --no-open           # Don't open browser
ao dashboard --rebuild           # Clean stale build artifacts first
```

**Options:**
- `-p, --port <port>` — Port to listen on
- `--no-open` — Don't open browser automatically
- `--rebuild` — Clean stale build artifacts and rebuild before starting

---

### `ao open [target]`
Open session(s) in terminal tabs (iTerm2).

```bash
ao open ao-7                     # Open specific session
ao open my-app                   # Open all sessions for a project
ao open all                      # Open all sessions
ao open ao-7 -w                  # Open in new window
```

**Arguments:**
- `[target]` — Session name, project ID, or `"all"`

**Options:**
- `-w, --new-window` — Open in a new terminal window

---

### `ao source-reply <session> [message...]`
Reply to the next pending inbound source message for an orchestrator session (e.g., reply to a Telegram or Jira message that was forwarded to the orchestrator).

```bash
ao source-reply ao-orchestrator "Approved, go ahead"
```

---

## How AO Sessions Work

### Architecture
- **Runtime:** tmux sessions (default) — each agent runs in its own tmux pane
- **Workspace:** git worktrees — lightweight, share `.git` with main repo
- **Metadata:** Flat key=value files in `~/.agent-orchestrator/<project>/<session>/`
- **Events:** JSONL event log per session

### Session Lifecycle
1. `ao spawn` creates worktree + tmux session + starts agent
2. Agent works autonomously (reads issue, writes code, creates PR)
3. Lifecycle manager polls for events (CI, reviews, merge conflicts)
4. Reactions auto-handle routine issues (send fix prompts to agents)
5. Notifier alerts humans when judgment is needed
6. `ao session cleanup` removes sessions with merged PRs

### Session Metadata Location
```
~/.agent-orchestrator/<project>/<session-id>/
  metadata.txt    # key=value pairs (status, branch, pr, issue, etc.)
  events.jsonl    # event log
```

### Attaching to Sessions
```bash
tmux attach -t <session-id>      # Attach directly
tmux ls                          # List all tmux sessions
ao open <session-id>             # Open in iTerm2 tab
```

### Reading Session Logs
```bash
# View recent tmux output
tmux capture-pane -t <session-id> -p -S -100

# View metadata
cat ~/.agent-orchestrator/<project>/<session-id>/metadata.txt

# View event log
cat ~/.agent-orchestrator/<project>/<session-id>/events.jsonl
```

---

## Common Workflows

### Spawn agents for multiple issues
```bash
ao batch-spawn my-app ISSUE-1 ISSUE-2 ISSUE-3 --open
ao status  # monitor progress
```

### Check on all agents
```bash
ao status                        # Overview table
ao status --json | jq '.[] | select(.ciStatus == "failure")'  # Find failing CI
```

### Fix a stuck agent
```bash
ao send <session> "You seem stuck. Try a different approach: ..."
```

### Send file-based instructions
```bash
ao send <session> -f detailed-instructions.md
```

### Clean up after a sprint
```bash
ao session cleanup --dry-run     # Preview
ao session cleanup               # Actually clean up
```

### Restart a crashed session
```bash
ao session restore <session>
```

### Override agent for a specific task
```bash
ao spawn my-app ISSUE-42 --agent codex  # Use Codex instead of Claude Code
```

---

## Configuration

Config file: `agent-orchestrator.yaml` (in project root or working directory).

Key fields:
- `dataDir` — Where session metadata is stored (default: `~/.agent-orchestrator`)
- `worktreeDir` — Where git worktrees are created (default: `~/.worktrees`)
- `port` — Dashboard port (default: 3000)
- `defaults.runtime` — Runtime plugin (`tmux`, `process`)
- `defaults.agent` — Agent plugin (`claude-code`, `codex`, `aider`)
- `defaults.workspace` — Workspace plugin (`worktree`, `clone`)
- `defaults.notifiers` — Notification channels (`desktop`, `slack`, `telegram`)
- `projects.<id>.repo` — GitHub `owner/repo`
- `projects.<id>.path` — Local path to repository
- `projects.<id>.defaultBranch` — Branch to create worktrees from
- `projects.<id>.sessionPrefix` — Prefix for session IDs
- `projects.<id>.tracker` — Issue tracker config (`github` or `linear`)
- `projects.<id>.agentRules` — Inline rules for agent prompts
- `projects.<id>.agentConfig.permissions` — `skip` for `--dangerously-skip-permissions`
- `reactions` — Auto-responses to CI failures, review comments, merge conflicts

---

## Tips for Working with Multiple Parallel Agents

1. **Use `ao status` frequently** — it's your control panel showing all agents, their PRs, CI status, and activity
2. **Use `batch-spawn`** — it handles deduplication and prevents spawning duplicate sessions
3. **Let reactions handle routine work** — CI failures and review comments are auto-forwarded to agents
4. **Use `ao session cleanup`** regularly — removes sessions with merged PRs to keep things tidy
5. **Send targeted messages** with `ao send` when an agent needs specific guidance
6. **Use `--json` output** for scripting: `ao status --json | jq ...`
7. **Monitor the dashboard** — `ao start` runs it alongside the orchestrator
8. **Restore crashed sessions** with `ao session restore` instead of respawning (preserves worktree and progress)
