# Show HN: Agent Orchestrator – Run parallel AI agents, get notified via Telegram

Hi HN,

I was running 8 Claude Code sessions in tmux panes, switching between them every few minutes to see if anything needed me. I'd miss CI failures for half an hour because I forgot to check pane 6. Agents would sit idle waiting for input I didn't know they needed. The actual AI coding was fine. The babysitting was killing me.

So I built Agent Orchestrator -- an open-source lifecycle manager for parallel AI coding agents. It spawns agents from your issue tracker, monitors their work, auto-handles routine problems (CI failures, review comments), and notifies you only when human judgment is actually needed. You reply from Telegram. The agent continues. You never open your laptop.

[DEMO GIF HERE]

**How it works in practice:** You point it at a GitHub/Jira/Linear board. Each issue becomes an agent session in an isolated git worktree. The agent codes, pushes, and opens a PR. If CI fails, the failure logs get routed back to the agent -- it tries to fix the build automatically up to N times. If a reviewer leaves a comment like "rename this variable," the agent handles it. You get pinged on Telegram/Slack/desktop only when something actually requires your brain.

The reply-from-Telegram part is what made this click for me. I was on the subway, got a notification that an agent was stuck on a flaky test, replied "skip it, focus on the API endpoint," and 10 minutes later had a merged PR. Never opened my laptop.

**Architecture:** The system has 8 swappable plugin slots: Runtime (tmux, process), Agent (Claude Code, Codex, Aider, OpenCode), Workspace (worktree, clone), Tracker (GitHub, Jira, Linear), SCM (GitHub), Notifier (desktop, Slack, Telegram, webhook), Terminal (iTerm2, web), and Lifecycle. Every slot implements an interface defined in a single `types.ts` file. You can swap any piece without touching the others. Want to run agents in Docker instead of tmux? Write a runtime plugin. Want notifications on Discord? Write a notifier plugin. The plugin contract is small -- most are under 200 lines.

The lifecycle engine is the core loop: poll tracker for new issues, spawn agent sessions, monitor CI status, route review comments, detect stuck agents, escalate to humans. It is a state machine, not a cron job. Sessions move through states (queued, running, waiting-for-ci, waiting-for-review, stuck, done) and each transition can trigger reactions.

The inbound message routing was the hard part. Each session has a FIFO queue backed by flat files with atomic file locking. Telegram messages get deduplicated by chatId:messageId and routed to the correct session via markers in reply chains. It's not elegant, but it's reliable and has zero external dependencies.

**What this doesn't do:** This doesn't make agents smarter. It doesn't improve code quality. If Claude Code writes bad code on its own, it'll write the same bad code through Agent Orchestrator. What it does is remove the overhead of managing multiple agent sessions manually -- the spawning, monitoring, notification routing, and CI/review loops that eat your time when you scale past 2-3 agents.

**Stack:** TypeScript (ESM), Node 20+, pnpm workspaces, Next.js 15 dashboard, Commander.js CLI. No database -- flat metadata files + append-only JSONL event log. MIT licensed. No telemetry. No cloud dependency.

**What makes this different from X:**

- **Cursor / Copilot Agent:** Great for single-agent workflows inside an IDE. Agent Orchestrator is for running 5-30 agents in parallel outside any IDE, with lifecycle management and notification routing. They're complementary, not competing.
- **dmux:** dmux focuses on multiplexing a single agent across terminal panes. AO manages the full lifecycle -- from issue tracker to merged PR -- including CI monitoring, review routing, and bidirectional messaging. Different scope.

Repo: [LINK]
Demo (60s, Telegram flow): [LINK]

I'd genuinely appreciate feedback on the plugin architecture and the lifecycle state machine. Are the 8 slots the right abstractions? Is there a slot missing? And if you've tried running multiple agents in parallel, I'd like to hear what problems you ran into.

---

## First Comment (post immediately after submission)

Some technical decisions people might want to debate:

**Why tmux as the default runtime?** The agents we support (Claude Code, Aider, OpenCode) are interactive CLI tools -- they expect a TTY. tmux gives us real terminal sessions we can attach to for debugging, and it's installed on basically every Linux/macOS dev machine. The tmux plugin is about 150 lines. We have a process-based runtime too for environments where tmux isn't available, but tmux lets you `ao attach session-id` and see exactly what the agent is doing, which is invaluable when things go wrong.

**Why flat files instead of SQLite/Redis?** Sessions are short-lived (minutes to hours) and there are rarely more than 30-50 active at once. A flat metadata file per session (key=value pairs) plus an append-only JSONL event log gives us everything we need with zero dependencies. You can `cat` a session file to see its state. You can `grep` the event log. You can copy the whole state directory to debug a problem. The FIFO message queues for inbound Telegram routing use the same approach -- one file per queue, atomic writes with rename, advisory file locking for concurrent access. We considered SQLite but it would have added complexity for a problem that doesn't need it at this scale.

**Why ESM and not CommonJS?** The ecosystem is moving to ESM and we didn't want to deal with dual-format plugins. Every package is `"type": "module"` with `.js` extensions in imports. It caused some pain with test tooling early on (vitest handles it well now), but it means plugin authors don't have to think about module format compatibility. One format, everywhere.

**Why YAML config instead of code?** The config is validated with Zod at load time, so you get clear error messages for invalid configs. YAML felt right because the config is declarative -- you're describing what you want (which agents, which tracker, which notifier, which reactions to automate), not writing logic. The `agent-orchestrator.yaml` file is typically 30-50 lines. Code-based config would have been more flexible but harder to share and version.

The inbound context routing (Telegram message -> correct agent session) is probably the most interesting piece architecturally. Happy to go deep on that if anyone's curious.
