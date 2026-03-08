# UI Design Prompt: Agent Orchestrator Dashboard

## Concept

Mission control dashboard for managing dozens of parallel AI coding agents. Think "air traffic control for AI developers" — the user spawns agents on coding tasks, walks away, and the dashboard surfaces only what needs human attention. Core UX principle: **push, not pull** — prioritize by urgency, not chronology.

## Visual Direction

Dark-themed developer tool. Monospace accents. Dense but scannable. Real-time feel (live dots, streaming indicators, subtle pulse animations). Inspired by Vercel dashboard density + Linear's polish + Grafana's operational urgency.

## Screens

### 1. Main Dashboard — Session Grid

- Top bar: project selector, global stats (active/idle/blocked/done counts), "Spawn" button
- Sessions grouped into **attention zones** (horizontal swim lanes or kanban columns):
  - **Merge** (green accent) — PR approved + CI green, one-click merge button prominent
  - **Respond** (orange accent) — agent waiting for human input, pulsing indicator
  - **Review** (red accent) — CI failed / changes requested / conflicts
  - **Pending** (gray) — waiting on external (CI running, reviewer)
  - **Working** (blue, subtle) — agent actively coding, don't interrupt
  - **Done** (dimmed) — merged/terminated, collapsible
- Each **session card** shows:
  - Session ID + branch name
  - Issue label/title (from GitHub/Linear/Jira)
  - PR status inline: PR number link, size badge (XS/S/M/L/XL), CI status dot (green/red/yellow/spinning), review decision badge (approved/changes requested/pending)
  - Activity indicator dot (green=active, yellow=ready, gray=idle, red=blocked, pulsing=waiting input)
  - Time since last activity ("2m ago", "1h ago")
  - Agent one-line summary of current work
- Real-time updates via SSE — cards shift between zones without page reload
- **Dynamic favicon** changes color based on highest-priority alert

### 2. Session Detail Page

- Split layout: left panel = context, right panel = live terminal
- Left panel:
  - Session metadata (ID, branch, agent, runtime, created time)
  - PR section: number, title, size, CI checks list (each with name + status icon + link), review decision, merge readiness, unresolved comment threads with "Ask agent to fix" action button
  - Agent summary (auto-generated description of what agent is doing)
  - Action buttons: Send Message, Kill Session, Restore
- Right panel:
  - Embedded terminal (xterm.js) showing live agent output
  - Fullscreen toggle
  - Connection status indicator (connecting/connected/error)
- Message input at bottom — text field to send instructions to the agent

### 3. Spawn Modal/Page

- Project dropdown
- Issue ID input (auto-detects tracker: GitHub issue, Linear ticket, Jira key)
- Agent override selector (Claude Code / Codex / Aider)
- "Spawn" action button

### 4. Integration Status Bar

- Small status indicators for: Telegram polling, Jira listeners, GitHub API health
- Shows connection state (connected/polling/error) for each integration

## Key UI Patterns

- **Attention-first layout**: most urgent items at top/left, done items collapsed at bottom
- **One-click merge**: the most satisfying action — green button, PR merges, card slides to "done"
- **Inline PR status**: no need to open GitHub — CI, review, mergeability visible on card
- **Live terminal embed**: watch agent work in real-time without leaving dashboard
- **Notification routing preview**: show which notifiers fire for each priority level
- **Activity pulse**: subtle breathing animation on cards where agent is actively working
- **Dense information design**: every pixel earns its place, no decorative whitespace

## Color System

- Background: near-black (#0a0a0a)
- Cards: dark gray (#141414) with subtle border (#262626)
- Attention zone accents: merge=emerald, respond=amber, review=red, pending=slate, working=blue, done=zinc
- Activity dots: active=green, ready=yellow, idle=gray, blocked=red
- CI status: passing=green, failing=red, pending=yellow/spinning
- PR size badges: XS=green, S=blue, M=yellow, L=orange, XL=red
- Text: primary=#e5e5e5, secondary=#a3a3a3, muted=#525252

## Typography

- UI: Inter or system sans-serif, 13-14px base
- Code/IDs/branches: JetBrains Mono or monospace, slightly smaller
- Stats/numbers: tabular figures for alignment

## Unique Features to Highlight in Design

1. **Attention zones** — the killer UX innovation, prioritizes human action
2. **One-click merge** — from dashboard, no GitHub context switch
3. **Embedded terminal** — watch AI agent code live
4. **Auto-recovery** — CI failure auto-sent to agent, visual indicator that agent is "retrying"
5. **Multi-agent parallelism** — 10-20 sessions visible simultaneously, compact cards
6. **Cross-tracker** — same UI for GitHub issues, Linear tickets, Jira tasks
7. **Push notifications** — Telegram/Slack/Desktop routing by urgency, configurable per-level
