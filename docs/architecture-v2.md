# Spur — Agent Orchestrator v2

## Overview

Spawn AI coding agents, walk away, get notified when your judgment is needed.

```
config → plugins → poll loop → ready

ao spawn  → worktree → tmux → agent → pipeline
ao done / goto / fail                → agent drives steps
events (CI, reviews, Sentry, ...)    → poke agent or advance pipeline
channels (Telegram, Slack, ...)      → notify human, receive commands
```

**Pipeline is the core abstraction.** Every session runs a pipeline. Steps define what the agent does. Events trigger transitions. The orchestrator polls, detects, emits — the pipeline decides what happens next.

**Everything is a plugin**: 6 standard interfaces + freeform capabilities (event sources, custom step types).

**State is durable**: flat metadata files + JSONL event log. tmux sessions survive orchestrator restarts. No database.

---

## 1. Orchestrator

### Boot (`ao start`)

```
ao start [project]
  1. Load agent-orchestrator.yaml
  2. Load plugins (create → init)
  3. Start polling loop (30s)
  4. Subscribe triggers (project-level event sources)
  5. Start channel receivers (Telegram polling, etc.)
  6. Write .ao-start-runtime.json (PID, port)
  → ready
```

If a runtime already exists (PID alive), attaches to it.

### Poll Loop

Every 30 seconds, for each active session:

```
1. tmux alive?       → no → mark killed or attempt restore
2. agent activity?   → active / ready / idle / waiting / blocked / exited
3. PR exists?        → check CI, reviews, merge readiness
4. pipeline step?    → evaluate on: / all: conditions, advance if met
5. status changed?   → update metadata, emit event via EventBus
```

### Shutdown (`ao stop`)

```
ao stop [project]
  1. Halt polling, stop channel receivers
  2. All plugins destroy()
  3. Remove .ao-start-runtime.json
```

Agent sessions are NOT killed — they keep running in tmux. Orchestrator can restart and re-attach.

### Sessions

**Spawn:**

```
ao spawn <project> [issue|prUrl] [--prompt "..."]
  1. Reserve session ID (prefix-N, atomic)
  2. Workspace.create() → git worktree on new branch
  3. Build prompt (issue context + user prompt + pipeline instructions)
  4. Agent.launch() → { command, env }
  5. Runtime.create() → tmux new-session -d, send launch command
  6. Write session metadata to dataDir
  → session running, pipeline begins
```

**Orchestrator session** — a meta-agent that manages other sessions. Gets a system prompt with available commands and all project context. Receives events, decides when to spawn, kill, message, or escalate.

```
ao start --orchestrator <project>
  → spawns agent session with management prompt
  → subscribes to project events
  → can ao spawn / ao send / ao kill from inside its session
```

**tmux:**

| Operation | How |
|-----------|-----|
| Create | `tmux new-session -d -s {id} -c {workspace}` + env vars |
| Send | `tmux send-keys` (short) or `load-buffer` + `paste-buffer` (>200 chars) |
| Check alive | `tmux has-session -t {id}` |
| Capture | `tmux capture-pane -t {id} -p -S -{lines}` |
| Destroy | `tmux kill-session -t {id}` |

**States:**

```
spawning → working → pr_open → review_pending → approved → merged
              │         │           │                        │
              ├── ci_failed ────────┘                       done
              ├── changes_requested ─┘
              ├── needs_input
              ├── stuck
              └── errored / killed / stopped  (terminal)
```

**CLI:**

| Command | Purpose |
|---------|---------|
| `ao start [project]` | Boot orchestrator |
| `ao stop [project]` | Shutdown orchestrator |
| `ao spawn <project> [issue]` | Create session |
| `ao status [-p project]` | List sessions |
| `ao send <session> <msg>` | Message an agent |
| `ao kill <session>` | Kill session + cleanup |
| `ao cleanup [-p project]` | Kill merged/closed sessions |
| `ao resume <session>` | Resume paused pipeline |
| `ao done` | Agent: step complete |
| `ao fail` | Agent: step failed |
| `ao goto <step>` | Agent: jump to step |
| `ao ask "question"` | Agent: ask human |

### Persistence

Pipeline state persisted on every transition. tmux and agent processes are independent of orchestrator.

| Component | Survives restart? | How |
|-----------|:-:|-----------|
| tmux sessions | yes | tmux server independent |
| agent process | yes | runs inside tmux |
| workspace | yes | files on disk |
| session metadata | yes | flat files in dataDir |
| pipeline state | yes | `pipeline.json` per session |
| event subscriptions | no | re-activated on recovery |

Recovery on startup:

```
tmux alive + agent alive      → resume, re-subscribe events
tmux alive + agent dead       → Agent.restore()
tmux dead                     → recreate tmux + restart agent
tmux dead + workspace missing → mark errored, notify human
```

After restore, orchestrator sends current step context to agent.

### Web Layer

Next.js dashboard + REST API + SSE for real-time updates.

```
GET  /api/sessions              → list all sessions
GET  /api/sessions/:id          → session details
POST /api/spawn                 → spawn new session
POST /api/sessions/:id/send     → send message to agent
POST /api/sessions/:id/kill     → kill session
POST /api/sessions/:id/restore  → restore dead session
GET  /api/events                → SSE stream (live session updates)
POST /api/tracker/tasks/start   → spawn session from tracker task
```

Dashboard is a view layer. All logic lives in core.

---

## 2. Plugins

One interface. Plugin declares what it provides — standard interfaces, event sources, custom step types. All optional.

```typescript
interface Plugin {
  name: string;

  runtime?(ctx: PluginContext): Runtime;
  agent?(ctx: PluginContext): Agent;
  workspace?(ctx: PluginContext): Workspace;
  tracker?(ctx: PluginContext): Tracker;
  scm?(ctx: PluginContext): SCM;
  channel?(ctx: PluginContext): Channel;

  events?: Record<string, Source>;
  steps?: Record<string, StepRunner>;

  init?(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}

interface PluginContext {
  config: Record<string, unknown>;
  eventBus: EventBus;
  logger: Logger;
}
```

| Interface | Responsibility | Examples |
|-----------|---------------|----------|
| `Runtime` | WHERE agents run | tmux, docker, k8s |
| `Agent` | WHICH AI tool | claude-code, codex, aider, opencode |
| `Workspace` | Code isolation | git worktree, git clone |
| `Tracker` | Issue/task tracking | GitHub Issues, Linear, Jira |
| `SCM` | PR lifecycle + CI + reviews | GitHub, GitLab |
| `Channel` | Human ↔ orchestrator | Telegram, Slack, desktop |

### EventBus

Central nervous system. All events flow through it — lifecycle transitions, plugin sources, pipeline signals, channel messages.

```typescript
interface EventBus {
  emit(event: string, data: Record<string, unknown>): void;
  on(event: string, handler: (data: Record<string, unknown>) => void): () => void;
}
```

Three event origins:

1. **Built-in** — lifecycle polling detects state changes, emits to bus (`ci:passed`, `review:approved`, `agent:stuck`, `merge:conflict`)
2. **Plugin sources** — async generators yield external signals (`sentry:error`, `webhook:incoming`, `cron:tick`)
3. **Pipeline** — step completions, channel responses, `on:` triggers

Pipeline `on:` handlers subscribe via EventBus. Channels receive events for routing to humans. Triggers listen for spawn conditions.

### Sources

**Built-in** — derived from lifecycle polling. SCM and agent activity are already polled every 30s. These events are observations, not separate sources:

```
ci:passed, ci:failed, review:approved, review:changes-requested,
review:comment, merge:conflict, merge:ready, agent:stuck, agent:exited
```

**Plugin-provided** — external signals. Async generators, not subscribe/unsubscribe:

```typescript
type Source = (scope: Scope) => AsyncIterable<Record<string, unknown>>;

interface Scope {
  session?: { id: string; project: ProjectConfig };
  step?: { id: string };
  signal: AbortSignal;
}
```

Plugin yields events. Orchestrator iterates. To stop: abort signal. Generator's `finally` cleans up. Convention: events carry a `message` field (used by `send` keyword in `on:` handlers).

```typescript
async function* sentryErrors(scope: Scope) {
  while (!scope.signal.aborted) {
    const errors = await sentry.getNewErrors();
    for (const error of errors) yield error;
    await sleep(30_000);
  }
}
```

Plugin declares events as a map:

```typescript
events: {
  "sentry:error": sentryErrors,
  "cron:tick": cronTick,
}
```

All lazy — generator instantiated only when subscribed, stopped when nobody listens.

### Channels

```typescript
interface Channel {
  name: string;
  send(msg: Message): Promise<string | null>;
  onMessage(handler: (msg: IncomingMessage) => void): () => void;
}

interface Message {
  text: string;
  threadId?: string;
  actions?: { id: string; label: string }[];
}

interface IncomingMessage {
  id: string;
  text: string;
  author: string;
  threadId?: string;
  actionId?: string;
}
```

One `send()`. One `onMessage()` returning unsubscribe. Routing is the orchestrator's concern.

Three roles: **notification** (status updates, alerts), **event source** (incoming messages become bus events), **control** (commands like `/spawn`, `/status`, `/kill`).

Orchestrator creates thread context per session. Human replies in that thread route to the session automatically. Thread tracking is per-channel (Telegram: message_thread_id, Slack: thread_ts, GitHub: PR conversation).

Each channel declares which event priorities it handles:

```yaml
channels:
  telegram:
    routing: { urgent: true, action: true, info: true }
  desktop:
    routing: { urgent: true, action: true }
```

### Step Runners

```typescript
type StepRunner = (step: PipelineStep, ctx: StepContext) => Promise<StepResult>;

interface StepContext {
  session: Session;
  send(message: string): Promise<void>;
  eventBus: EventBus;
  signal: AbortSignal;
}

type StepResult = { status: "completed"; output?: Record<string, unknown> }
               | { status: "failed"; reason: string };
```

### Plugin Examples

```typescript
export default {
  name: "github",
  scm: (ctx) => new GitHubSCM(ctx.config),
  tracker: (ctx) => new GitHubTracker(ctx.config),
} satisfies Plugin;

export default {
  name: "sentry",
  events: { "sentry:error": sentryErrors },
  async init(ctx) { sentry.init(ctx.config.dsn); },
  async destroy() { sentry.close(); },
} satisfies Plugin;

export default {
  name: "tmux",
  runtime: () => new TmuxRuntime(),
} satisfies Plugin;
```

Lifecycle: `init(ctx)` on boot → interface factories called → orchestrator runs → `destroy()` on shutdown.

---

## 3. Agent

Every CLI agent implements the same contract. Orchestrator doesn't know agent internals.

```typescript
interface Agent {
  readonly name: string;
  readonly processName: string;

  launch(config: LaunchConfig): { command: string; env: Record<string, string> };
  activity(session: Session): Promise<Activity | null>;
  alive(handle: RuntimeHandle): Promise<boolean>;
  restore(session: Session, project: ProjectConfig): Promise<string | null>;
}

interface LaunchConfig {
  sessionId: string;
  project: ProjectConfig;
  prompt?: string;
  instructions?: string;
  permissions?: "skip" | "default";
  model?: string;
  args?: string[];
}
```

Each agent translates universal config into its own CLI:

```
claude-code → claude --dangerously-skip-permissions --model sonnet --append-system-prompt "..."
codex       → codex --model o4-mini --approval-mode full-auto "prompt"
aider       → aider --model claude-3.5-sonnet --yes "prompt"
```

**Config** — per project, with step-level override. Resolution: step → project → defaults.

**Activity** — agent-specific detection, same interface:

| Agent | Method |
|---|---|
| claude-code | JSONL log (native, preferred) |
| codex | Process stdout / exit code |
| aider | Terminal output patterns |

Returns: `active`, `ready`, `idle`, `waiting`, `blocked`, `exited`.

**Restore** — when orchestrator restarts, agent may still be alive in tmux. `restore()` returns the resume command (e.g. `claude --resume <id>`). `null` = no resume, orchestrator re-sends context.

### Agent ↔ Orchestrator Communication

Three channels, from low to high level:

1. **Environment** — `AO_SESSION`, `AO_PROJECT`, `AO_API_URL`, `AO_STEP` injected at launch. Agent knows who it is and where to call back.

2. **CLI** — `ao done`, `ao fail`, `ao goto <step>`, `ao ask "question"`. Agent calls from terminal to drive pipeline.

3. **MCP tools** — same commands exposed as MCP tools (`pipeline_done`, `pipeline_fail`, `pipeline_goto`, `pipeline_ask`). Preferred for agents that support MCP natively (claude-code). No shell overhead, structured input/output.

```typescript
// MCP tool: pipeline_done
{ output?: Record<string, unknown> }

// MCP tool: pipeline_fail
{ reason: string }

// MCP tool: pipeline_goto
{ step: string }

// MCP tool: pipeline_ask
{ question: string, options?: string[] }
```

Orchestrator injects pipeline context via `instructions` field appended to the agent's system prompt.

---

## 4. Pipeline

Linear steps. One agent session, one context, start to finish. No parallelism, no DAG.

### Steps

A step is defined by its shape — no `type:` field.

| Key present | What happens |
|---|---|
| `prompt:` | Agent works on it. Completes on `ao done`. |
| `run:` | Shell command. Completes on exit 0. |
| `channel:` + `message:` | Sends to channel. Waits if `options:` or `allowText:` present. |
| none of above | Pure wait. Reacts via `on:`. |

```yaml
pipeline:
  steps:
    - id: implement
      prompt: "Implement the feature described in the issue"

    - id: test
      run: "pnpm test"

    - id: review
      prompt: "Review the changes, fix if needed"

    - id: approval
      channel: telegram
      message: "PR ready: {{session.pr.url}}"
      options:
        approve: Ship it
        reject: Needs work
      on:
        approve: done
        reject: goto implement

    - id: merge
      run: "gh pr merge --merge"
```

Five steps. Zero type declarations. A prompt IS a task. A `run:` IS a script. A channel message with options IS a human input step. Shape = intent.

No `pipeline.steps` → single implicit step. Agent works until `ao done` or session killed.

### `on:` — Transitions and Events

The universal event → action bridge. Available on any step.

```yaml
on:
  ci:passed: done                         # keyword → advance pipeline
  merge:conflict: send                    # keyword → forward event.message
  ci:failed: "Fix CI: {{event.summary}}"  # string → custom message
  sentry:error:                           # object → message + retries
    send: "Production error: {{event.title}}"
    retries: 3
```

| Value | Meaning |
|---|---|
| `done` / `fail` / `pause` | Pipeline transition |
| `goto <step>` | Jump to step |
| `send` | Forward `event.message` to agent |
| `"message"` | Send custom message to agent |
| `{ send, retries, goto }` | Message + options (object form requires at least `retries` or `goto`) |

One way per intent. Keyword for actions. String for messages. Object only when you need retries/goto — `{ send: "Fix CI" }` without extras is invalid, use `"Fix CI"` string.

Events in `on:` keys are subscribed automatically — no separate `events:` field needed. Keys with `:` are event names. `fail` and `timeout` are step-level events.

**Events during a running step** — interrupt the agent:

```yaml
- id: implement
  prompt: "Build the feature"
  on:
    merge:conflict: send
    sentry:error: send
    ci:failed: "Fix CI: {{event.summary}}"
```

**Pure wait** — step with only `on:`:

```yaml
- id: wait-ci
  timeout: 30m
  on:
    ci:passed: done
    ci:failed: "CI failed: {{event.summary}}"
    timeout: fail
```

**Human choice** — channel step with `options:`, option IDs become `on:` keys:

```yaml
- id: approval
  channel: telegram
  message: "PR ready: {{session.pr.url}}"
  options:
    approve: Ship it
    reject: Needs work
  on:
    approve: done
    reject: goto implement
    timeout: fail
  timeout: 24h
```

**Human free text:**

```yaml
- id: describe-bug
  channel: telegram
  message: "Describe the expected behavior"
  allowText: true
```

Response stored in `steps.<id>.output.response`.

### `all:` — Parallel Conditions

`on:` handles events one-by-one. Real workflows need AND — "merge when CI passed AND review approved."

```yaml
- id: merge-ready
  all: [ci:passed, review:approved]
  on:
    ci:failed: "Fix CI: {{event.summary}}"
    review:changes-requested: goto implement
  timeout: 1h
```

State convergence, not event accumulation. Orchestrator tracks the latest event per namespace (prefix before `:`). Step advances when all `all:` conditions match current state.

```
1. ci:passed     → ci=passed,  review=?        → wait
2. ci:failed     → ci=failed,  review=?        → "Fix CI" → agent
3. agent fixes, pushes
4. ci:passed     → ci=passed,  review=?        → wait
5. review:approved → ci=passed, review=approved → ALL MET → advance
```

`ci:failed` fires → namespace `ci` updates to `failed` → `ci:passed` condition no longer met. When CI passes again → namespace returns to `passed`. Events don't accumulate — they overwrite.

Without `all:` everything works as before. `all:` is purely additive.

### `ao ask` — Agent Asks Human Mid-Step

Agent encounters ambiguity, asks human without leaving the step. Blocking.

```bash
ao ask "How should I handle the auth error?"
ao ask "Which approach?" --options "Retry,Skip,Rewrite"
```

### Agent Communication

Orchestrator sends step context when entering a step:

```
═══ Pipeline Step: review (iteration 1/3) ═══
Prompt: Review the changes, fix if needed.

Available actions:
  ao done              → advance to: approval
  ao goto implement    → go back to fix issues (2 iterations remaining)
  ao fail --reason "." → pause pipeline, notify human
═══════════════════════════════════════════════
```

Agent drives via CLI / MCP tools:

```bash
ao done                            # advance to next step
ao done --output '{"pr": 42}'     # with output data
ao fail --reason "tests broken"   # mark failed
ao goto <step-id>                  # jump to step
ao ask "question"                  # ask human, block
```

### Agent Loop

`goto` sends the pipeline backwards:

```
implement → test → review → implement (goto) → test → review → done
```

`goto: [implement]` restricts allowed targets. `maxIterations` limits loops.

```yaml
pipeline:
  maxIterations: 5
  steps:
    - id: implement
      prompt: "Implement the feature"
      maxIterations: 3

    - id: review
      prompt: "Review. If issues found, goto implement."
      goto: [implement]
```

### Triggers

Project-level event → spawn handlers. Subscribe on boot, run continuously.

```yaml
triggers:
  sentry-autofix:
    event: sentry:error
    filter: { level: error, firstSeen: true }
    spawn:
      prompt: "Fix: {{event.data.title}}\n{{event.data.stacktrace}}"

  jira-autostart:
    event: jira:assigned
    filter: { assignee: "agent@company.com" }
    spawn:
      prompt: "Work on {{event.data.issueKey}}: {{event.data.summary}}"

  daily-review:
    event: cron:tick
    schedule: "0 9 * * 1-5"
    spawn:
      prompt: "Review all open PRs"
```

Same `Source` interface. `event:` names the source, `filter:` is orchestrator-side, `spawn:` is the action. Plugin doesn't know about filters.

### Recovery

```yaml
pipeline:
  recovery:
    retries: 2
    delay: 5s
    exhausted: pause          # pause | fail | goto <step>
  steps:
    - id: implement
      prompt: "..."
      recovery:
        retries: 3
        exhausted: goto review
```

```
step fails → retry 1 → retry 2 → retry 3 → exhausted
  exhausted: pause  → pipeline paused, human notified
  exhausted: fail   → pipeline failed
  exhausted: goto X → jump to step X
```

Resume: `ao resume <session> [--step X] [--message "..."]`

### Conditions

```yaml
- id: deploy
  run: "deploy.sh staging"
  when: "{{steps.test.output.allPassed}}"
```

References: `steps.<id>.output`, `steps.<id>.status`, `env.<VAR>`, `session.pr`, `session.branch`. Falsy → step skipped.

### Step States

```
pending → running → completed
                  → failed (→ retry → running)
                  → rewound (goto jumped back)
                  → skipped (when: was false)
```

Pipeline: `running` | `completed` | `failed` | `paused`.

Every transition logged to JSONL.

---

## 5. Config

```yaml
defaults:
  runtime: tmux
  workspace: worktree
  agent:
    use: claude-code
    permissions: skip

plugins:
  sentry:
    package: "@ao/plugin-sentry"
    config:
      dsn: ${SENTRY_DSN}
      org: my-org
  prometheus:
    package: "./plugins/prometheus"
    config:
      endpoint: http://localhost:9090

channels:
  telegram:
    plugin: telegram
    pollInterval: 2s
    commands: true
    routing:
      urgent: true
      action: true
      info: true

  slack:
    plugin: slack
    token: ${SLACK_TOKEN}
    channel: "#ao-notifications"
    commands: true
    routing:
      urgent: true

  desktop:
    plugin: desktop
    commands: false
    routing:
      urgent: true
      action: true

projects:
  backend-api:
    repo: org/backend-api
    path: ~/backend-api
    branch: main
    prefix: api

    # workspace setup
    symlinks: [node_modules, .claude, AGENTS.md]
    postCreate: ["pnpm install"]
    agent:
      use: claude-code
      model: sonnet
      args: ["--max-turns", "80"]

    pipeline:
      maxIterations: 5
      recovery:
        retries: 2
        exhausted: pause
      steps:
        - id: implement
          prompt: "Implement the feature from the issue"
          maxIterations: 3
          on:
            merge:conflict: send
            sentry:error: send

        - id: merge-ready
          all: [ci:passed, review:approved]
          timeout: 2h
          on:
            ci:failed: "CI failed: {{event.summary}}"
            review:changes-requested: goto implement

        - id: approval
          channel: telegram
          message: "PR ready: {{session.pr.url}}\nCI ✓ Review ✓"
          options:
            merge: Ship it
            reject: Needs work
          on:
            merge: done
            reject: goto implement
          timeout: 24h

        - id: merge
          run: "gh pr merge --squash"

    triggers:
      jira-autostart:
        event: tracker:task-available
        poll: { interval: 5m, filters: { iteration: current } }
        spawn: {}

      sentry-autofix:
        event: sentry:error
        filter: { level: error, firstSeen: true }
        spawn:
          prompt: "Fix: {{event.data.title}}"

      daily-review:
        event: cron:tick
        schedule: "0 9 * * 1-5"
        spawn:
          prompt: "Review all open PRs, add comments"

  # ─── different agent, minimal pipeline ───
  ml-pipeline:
    repo: org/ml-pipeline
    path: ~/ml-pipeline
    branch: main
    prefix: ml

    agent:
      use: codex
      model: o4-mini

    pipeline:
      steps:
        - id: implement
          prompt: "Implement the feature"

        - id: merge-ready
          all: [ci:passed, review:approved]
          on:
            ci:failed: send
            review:changes-requested: goto implement

        - id: merge
          run: "gh pr merge --merge"

  # ─── no pipeline: agent works freely until done ───
  docs:
    repo: org/docs
    path: ~/docs
    branch: main
    prefix: doc
    agent:
      use: aider
      model: claude-3.5-sonnet
```

### Workspace Setup

When a session is spawned, the workspace gets prepared:

1. `Workspace.create()` → git worktree (or clone) on new branch
2. `symlinks` → symlinked from main repo (node_modules, config files, agent rules)
3. `postCreate` → shell commands run in workspace (install deps, build, etc.)
4. `Agent.setupWorkspaceHooks()` → agent-specific config for auto-metadata updates (e.g. Claude Code's PostToolUse hook that updates PR/branch info after git commands)

---

## Implementation Plan

Build in `v2/` subfolder alongside existing packages. Replace root when ready. Plugin implementations port from v1 (`packages/plugins/`).

### Phase 1 — Types + Config + Metadata

```
v2/src/types.ts      — Plugin, Runtime, Agent, Workspace, SCM, Tracker, Channel, Session, EventBus
v2/src/config.ts     — YAML loader + Zod validation
v2/src/metadata.ts   — flat file read/write/list/reserve-id (port from core/metadata.ts)
```

No runtime behavior. Just the type contracts and data layer. Everything else depends on this.

### Phase 2 — Plugins + Session Manager + CLI

```
v2/src/plugins.ts              — load plugins from config, resolve by name
v2/src/plugins/tmux.ts         — Runtime: new-session, send-keys, capture, kill (port)
v2/src/plugins/worktree.ts     — Workspace: git worktree add/remove (port)
v2/src/plugins/claude-code.ts  — Agent: launch command, env, activity detection (port)
v2/src/session.ts              — spawn, list, get, kill, send
v2/src/cli.ts                  — ao spawn / status / send / kill
```

**Milestone:** `ao spawn backend-api 42` creates worktree + tmux + agent. `ao status` lists sessions. `ao kill` cleans up. Multiple parallel sessions.

### Phase 3 — Pipeline Engine

```
v2/src/event-bus.ts    — emit/on/once, typed events
v2/src/pipeline.ts     — step state machine, on: evaluation, all: tracking, transitions
v2/src/pipeline.json   — per-session persistence (written on every transition)
v2/src/mcp-server.ts   — MCP tools: pipeline_done, pipeline_fail, pipeline_goto, pipeline_ask
v2/src/prompt.ts       — inject step context + available actions into agent system prompt
```

Pipeline loads from config, runs step-by-step. Agent calls `ao done` (CLI) or `pipeline_done` (MCP) to advance. `goto` loops back. `fail` pauses. Step context sent to agent on each transition.

**Milestone:** agents drive through multi-step pipelines. `implement → test → review → done` works end-to-end.

### Phase 4 — Lifecycle Polling + SCM

```
v2/src/lifecycle.ts          — polling loop (30s), status transitions, event emission
v2/src/plugins/github.ts     — SCM: detect PR, CI checks, reviews, merge readiness, merge (port)
```

Polling loop checks each session: tmux alive → agent activity → PR status → CI → reviews. State changes emit to EventBus. Pipeline `on:` handlers react (`ci:failed → send`, `review:approved → done`). `all: [ci:passed, review:approved]` gates work.

**Milestone:** full automation loop. Agent pushes code → CI runs → reviews come in → pipeline reacts → agent fixes → merge.

### Phase 5 — Channels

```
v2/src/plugins/telegram.ts   — Channel: send, onMessage, polling, thread tracking
v2/src/plugins/desktop.ts    — Channel: native notifications (port)
```

Channel pipeline steps work: `channel: telegram` + `message:` + `options:`. Human replies route to session. `ao ask` sends question to channel, blocks until response. Notification routing by priority.

**Milestone:** human-in-the-loop. Agent asks for approval via Telegram, human taps "Ship it", pipeline merges.

### Phase 6 — Tracker + Sources + Triggers + Web

```
v2/src/plugins/github-tracker.ts  — Tracker: get issue, generate prompt, branch name (port)
v2/src/plugins/jira.ts            — Tracker: Jira integration (port)
v2/src/sources.ts                 — async generator lifecycle, abort signal, lazy instantiation
v2/src/triggers.ts                — event → filter → spawn mapping
v2/src/web/                       — Next.js dashboard + REST API + SSE (port from packages/web/)
```

**Milestone:** Sentry error auto-spawns fix session. Jira assignment auto-starts agent. Dashboard shows everything.

### Phase 7 — Remaining Agents + Recovery + Polish

```
v2/src/plugins/codex.ts       — Agent: codex CLI adapter
v2/src/plugins/aider.ts       — Agent: aider CLI adapter
v2/src/plugins/opencode.ts    — Agent: opencode CLI adapter
v2/src/plugins/clone.ts       — Workspace: git clone (alternative to worktree)
```

Recovery (retries, exhausted actions). Conditions (`when:`). Orchestrator session. Pipeline templates. Step-level agent override. Restore logic.

### Order Rationale

Each phase delivers a usable system. Phase 2 = manual agent control. Phase 3 = pipeline automation. Phase 4 = CI/review loop. Phase 5 = human communication. Phase 6 = external integrations. No phase depends on a later one.

Port from v1 where logic exists. Build new where v2 diverges (pipeline, EventBus, MCP server, channels).

---

## Open Questions

1. **Trigger deduplication** — `sentry:error` fires 100 times for the same bug. Debounce? Dedup key in filter?
2. **Pipeline templates** — reusable step sequences across projects. `pipeline: template:ci-review-merge`?
3. **`when:` expressions** — template interpolation + truthy check? Or expression engine (jexl)?
4. **Channel auth** — who can `/spawn` via Telegram? Chat ID whitelist? Token per channel?
5. **Project-level `on:`** — default event handlers that apply to all sessions regardless of pipeline step (v1 reactions, but in v2 syntax)?
