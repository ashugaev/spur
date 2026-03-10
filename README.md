<h1 align="center">Agent Orchestrator — The Orchestration Layer for Parallel AI Agents</h1>

<p align="center">
<a href="https://platform.composio.dev/?utm_source=Github&utm_medium=Banner&utm_content=AgentOrchestrator">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</a>
</p>

<div align="center">

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, resolve merge conflicts, and open PRs. When configured, approved green PRs can be merged automatically.

[![GitHub stars](https://img.shields.io/github/stars/ashugaev/ao?style=flat-square)](https://github.com/ashugaev/ao/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs merged](https://img.shields.io/badge/PRs_merged-61-brightgreen?style=flat-square)](https://github.com/ashugaev/ao/pulls?q=is%3Amerged)
[![Tests](https://img.shields.io/badge/test_cases-3%2C288-blue?style=flat-square)](https://github.com/ashugaev/ao/releases/tag/metrics-v1)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. If a PR hits merge conflicts, the orchestrator can auto-dispatch a conflict-resolution prompt to the agent. If a PR is approved and green, the orchestrator can auto-merge it.

**Agent-agnostic** (Claude Code, Codex, Aider) · **Runtime-agnostic** (tmux, Docker) · **Tracker-agnostic** (GitHub, Linear)

<div align="center">

## See it in action

<a href="https://x.com/agent_wrapper/status/2026329204405723180">
  <img src="docs/assets/demo-video-tweet.png" alt="Agent Orchestrator demo — AI agents building their own orchestrator" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="docs/assets/btn-watch-demo.png" alt="Watch the Demo on X" height="48"></a>
<br><br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945">
  <img src="docs/assets/article-tweet.png" alt="The Self-Improving AI System That Built Itself" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945"><img src="docs/assets/btn-read-article.png" alt="Read the Full Article on X" height="48"></a>

</div>

## Quick Start

**Option A — From a repo URL (fastest):**

```bash
# Install
git clone https://github.com/ashugaev/ao.git
cd agent-orchestrator && bash scripts/setup.sh

# One command to clone, configure, and launch
ao start https://github.com/your-org/your-repo
```

Auto-detects language, package manager, SCM platform, and default branch. Generates `agent-orchestrator.yaml` and starts the dashboard + orchestrator.

**Option B — From an existing local repo:**

```bash
cd ~/your-project && ao init --auto
ao start
```

Then spawn agents:

```bash
ao spawn my-project 123    # GitHub issue, Linear ticket, or ad-hoc
```

Dashboard opens at `http://localhost:3000`. Run `ao status` for the CLI view.

## How It Works

```
ao spawn my-project 123
```

1. **Workspace** creates an isolated git worktree with a feature branch
2. **Runtime** starts a tmux session (or Docker container)
3. **Agent** launches Claude Code (or Codex, or Aider) with issue context
4. Agent works autonomously — reads code, writes tests, creates PR
5. **Reactions** continuously monitor CI/review/conflict state, auto-handle CI failures and review comments, auto-dispatch merge-conflict resolution prompts to agents, and can auto-merge approved+green PRs
6. **Notifier** pings you only when judgment is needed

### Plugin Architecture

Eight slots. Every abstraction is swappable.

| Slot | Default | Alternatives |
|------|---------|-------------|
| Runtime | tmux | docker, k8s, process |
| Agent | claude-code | codex, aider, opencode |
| Workspace | worktree | clone |
| Tracker | github | linear |
| SCM | github | — |
| Notifier | desktop | slack, composio, webhook |
| Terminal | iterm2 | web |
| Lifecycle | core | — |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

## Configuration

```yaml
# agent-orchestrator.yaml
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  review-comments:
    auto: true
    action: send-to-agent
    message: "There are unresolved review comments. Address each one, push fixes, and reply."
    escalateAfter: 30m
  merge-conflicts:
    auto: true
    action: send-to-agent
    message: "Your branch has merge conflicts. Rebase on the default branch, resolve conflicts, and push."
    escalateAfter: 15m
  approved-and-green:
    auto: true
    action: auto-merge
    mergeMethod: squash   # optional: merge | squash | rebase (default: squash)
```

CI fails → agent gets the logs and fixes it. Reviewer requests changes → agent addresses them. Unresolved review comments can also be auto-forwarded to the agent even when review status does not flip to `changes_requested`. Merge conflicts are continuously monitored; when conflicts appear, the orchestrator auto-sends conflict-resolution instructions to the agent (with retry/escalation policy). PR approved with green CI → orchestrator merges automatically when `approved-and-green` is set to `auto-merge` (or notifies if set to `notify`). If `mergeMethod` is omitted, `squash` is used.

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference.

### Tracker Intake

Auto-spawn from issue trackers uses `source: tracker-task` plus portable `filters` (`state`, `assignee`, `labels`, `limit`). The same contract works in top-level `listeners` and per-project `projects.<id>.listeners`.

`jql` is intentionally not part of this schema. It is Jira-specific and would hardcode Jira into a tracker-generic listener. The shared listener calls `tracker.listIssues(...)`; Jira-specific query semantics belong inside the Jira tracker plugin, not in the common config format.

## CLI

```bash
ao status                              # Overview of all sessions
ao spawn <project> [issue]             # Spawn an agent
ao send <session> "Fix the tests"      # Send instructions
ao session ls                          # List sessions
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
ao dashboard                           # Open web dashboard
```

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents, check if they're stuck, read CI failures, forward review comments, track which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao spawn` and walk away. The system handles isolation, feedback routing, and status tracking. You review PRs and make decisions — the rest is automated.

## Prerequisites

- Node.js 20+
- Git 2.25+
- tmux (for default runtime)
- `gh` CLI (for GitHub integration)

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests (3,288 test cases)
pnpm dev                       # Start web dashboard dev server
```

See [CLAUDE.md](CLAUDE.md) for code conventions and architecture details.

## Documentation

| Doc | What it covers |
|-----|---------------|
| [Setup Guide](SETUP.md) | Detailed installation and configuration |
| [Examples](examples/) | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, plugin pattern |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues and fixes |

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. Every plugin is an implementation of a TypeScript interface — see [CLAUDE.md](CLAUDE.md) for the pattern.

## License

MIT
