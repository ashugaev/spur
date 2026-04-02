# Research 7: Terminal-Based Agent Status Detection

## Problem Statement

When an orchestrator manages agents running inside tmux sessions, it needs to
know what each agent is doing: working, waiting for a new prompt, or blocked on
human input. Agents expose no standard status API, so the orchestrator must
infer state from indirect signals. Five approaches exist, each with different
reliability, latency, and coupling characteristics.

---

## 1. Pane Capture Regex

**How it works.** `tmux capture-pane -t <session> -p -S -N` dumps the last N
lines of visible terminal content. The orchestrator applies regex patterns to
classify state: a prompt character (`>`, `$`, `❯`) on the last non-empty line
means "waiting"; phrases like "esc to interrupt" or "Thinking" mean "working";
permission prompts or interview-style option lists mean "needs_input".

**Spur implementation.** `classifyLivePaneState` in `session-service.ts`
normalizes pane lines (strips trailing UI chrome like `─` bars, `⏵⏵` markers,
"Update available!" banners), then checks permission prompt regexes, interview
patterns, and finally falls back to `PROMPT_RE` on the last line. For Codex,
`classifyCodexPane` checks question patterns before the generic "esc to
interrupt" working pattern because Codex renders `esc to interrupt` in both
active and question UI states.

**Real-world examples.**
- [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator):
  tmux plugin that captures pane content to classify Claude Code, Codex, and
  custom agent states into running/needs-input/done, surfacing them as pane
  border colors and status bar icons.
- [NTM (Named Tmux Manager)](https://github.com/Dicklesworthstone/ntm):
  multi-agent tmux orchestrator that scrapes pane content for agent status
  cards (idle, processing, stuck) with token velocity badges.
- Spur's legacy `scripts/send-to-session`: checks last non-empty line for `❯`
  or `$` (idle) and recent lines for "esc to interrupt" (busy).

### Pros

- **Zero agent cooperation required.** Works with any terminal program.
- **Rich signal.** Can detect permission prompts, option lists, error
  messages, and other visual states that no other approach captures.
- **Immediate.** No file I/O or IPC delay; tmux reads directly from the
  terminal buffer.

### Cons

- **Fragile.** Any UI change (new prompt character, reordered chrome,
  spinner on the last line) breaks classification.
- **The "prompt is always visible" problem.** TUI apps that always render a
  prompt line (like Codex's `›`) make it impossible to distinguish "idle at
  prompt" from "working with prompt visible." See section 3 below.
- **Ambiguous shared patterns.** Codex renders "esc to interrupt" during both
  active work and interactive questions. The classifier must check question
  patterns first, which is ordering-dependent and brittle.
- **Trailing UI chrome.** Status bars, separator lines, update banners, and
  model info lines sit below meaningful content. Spur strips these with
  `TRAILING_UI_RE`, but every new chrome element needs a new regex.
- **Window size sensitivity.** Narrow terminals wrap lines, breaking
  line-based pattern matching. Spur uses `normalizePaneLines` to join and
  re-split, but edge cases persist.
- **Polling cost.** Each classification requires a tmux IPC round-trip. At
  scale (many sessions, frequent polls), this adds latency.

---

## 2. Terminal Title

**How it works.** Some TUI agents set the terminal pane title (via ANSI escape
`\e]2;...\a`) to reflect their current state. The orchestrator reads the title
with `tmux display-message -t <session> -p "#{pane_title}"` and classifies
based on keywords.

**Spur implementation.** `classifyCodexTitle` in `session-service.ts` checks
for Codex-specific title patterns: "Ready" maps to waiting, "Thinking" /
"Working" / "Starting" maps to working, "Waiting" maps to needs_input. A
Braille spinner prefix (`⠋`, `⠙`, etc.) indicates the agent is active. If
the title is just the session name with no spinner and no status keyword, the
agent is idle (waiting). If the title has a spinner but no keyword, the
classifier returns `null` and falls through to pane capture.

This approach is only used for Codex; Claude Code does not set structured
pane titles.

### Pros

- **Instant and cheap.** Reading `#{pane_title}` is a single tmux query with
  no buffer scan.
- **Structured signal.** When the agent sets status keywords, there is no
  ambiguity. "Ready" means ready; "Thinking" means thinking.
- **Avoids the always-visible-prompt problem.** Title changes happen at state
  transitions, not on every render frame.

### Cons

- **Agent must cooperate.** Only works if the agent actively sets the
  terminal title. Claude Code does not do this.
- **Limited vocabulary.** Title is typically a short string. Cannot convey
  rich state like "blocked on permission for file X."
- **Version-dependent.** Title format can change between agent releases.
  Codex's Braille spinner prefix is an implementation detail, not a contract.
- **Fallthrough required.** Even when used, some states (Braille spinner
  without keyword) still require pane capture as a fallback.

---

## 3. Hook Events

**How it works.** Claude Code and Codex support lifecycle hooks: scripts or
HTTP endpoints called on `SessionStart`, `UserPromptSubmit`, `Stop`, and other
events. The hook receives a JSON payload with the event name, turn ID, and
other metadata. The orchestrator registers a hook script that writes the event
to a known file; the daemon reads that file to determine state.

**Spur implementation.** During session setup, `ensureClaudeHookSettings`
(claude.ts) and `ensureCodexHookSettings` (codex.ts) write a hooks config
that fires `$SPUR_AGENT_STATE_COMMAND` on `SessionStart`, `UserPromptSubmit`,
and `Stop`. That command runs the inline `spur-agent-state-updater.mjs` script,
which reads the hook payload from stdin, maps the event name to a state
(`UserPromptSubmit` -> working, `SessionStart`/`Stop` -> waiting), and
atomically writes a JSON record to
`<dataDir>/session-agent-state/<sessionId>.json` via tmp+rename.

The daemon reads this file in `readAgentHookState` (agent-hook-state.ts) and
applies freshness logic:
- **Fresh working** (within `HOOK_FRESHNESS_MS` = 2s): trust it, skip pane
  capture entirely.
- **Waiting**: trust the hook, but still check pane capture for `needs_input`
  since the agent cannot signal permission prompts via hooks.
- **Stale or absent**: fall through to full pane classification.

**Real-world examples.**
- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability):
  captures every hook event (PreToolUse, PostToolUse, Stop, etc.) and streams
  to a live dashboard showing what each agent is doing, which tools it calls,
  and parent-child subagent relationships.
- [agents-observe](https://github.com/simple10/agents-observe): similar
  real-time hook event streaming to a dashboard.
- [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator):
  uses Claude Code hooks to drive pane border color changes on state
  transitions.
- Claude Code's official hooks support four handler types: command (shell),
  HTTP POST, prompt (Claude model evaluation), and agent (subagent
  verification).

### Pros

- **Authoritative.** The agent itself reports its state transitions. No
  guessing from visual artifacts.
- **Low latency.** File write happens synchronously in the hook; the daemon
  reads it on the next poll with a simple `readFileSync`.
- **Eliminates the always-visible-prompt problem.** Hooks fire on actual
  state transitions, not on render frames. A `Stop` hook means the agent
  finished, regardless of what the terminal looks like.
- **Extensible.** Hook payloads carry turn IDs, timestamps, and event names.
  The orchestrator can use these for audit logging, token tracking, and
  cost attribution.

### Cons

- **Agent must support hooks.** Not all agents have hook systems. Custom or
  legacy agents may not.
- **Missing events.** Hooks do not fire for permission prompts, interactive
  questions, or approval dialogs. These states still require pane capture.
- **Stale data.** A "working" hook becomes stale if the agent crashes or
  hangs without firing "Stop." Spur addresses this with a 2-second freshness
  window: after 2s without a new hook, the daemon falls back to pane capture.
- **Setup complexity.** Each agent has a different hook config format (Claude
  Code uses `settings.json` hooks, Codex uses `hooks.json`). The orchestrator
  must generate and maintain these per-session config files.
- **Atomic write races.** If the hook fires while the daemon is reading, the
  file could be partially written. Spur uses tmp+rename for atomicity, which
  works on POSIX but adds complexity.

---

## 4. Process Tree Inspection

**How it works.** The orchestrator checks whether the agent process is still
running by examining the process tree attached to the tmux pane's TTY. This
answers the binary question "is the agent alive?" rather than "what is the
agent doing?"

**Spur implementation.** `isProcessRunningInTmux` in `runtime-tmux.ts`:
1. `tmux list-panes -t <session> -F "#{pane_tty}"` to get the TTY device(s).
2. `ps -eo pid,tty,args` to get all processes.
3. Match processes on the pane's TTY whose args match the agent binary name.

This is used as a gate before state classification: if
`!runtimeAlive || !processAlive`, the state is `stopped` regardless of pane
content. It is also used during send, restore, and kill flows to verify the
agent is actually running before attempting interaction.

**Real-world examples.**
- Claude Agent SDK: uses process polling (check PID alive) for heartbeat
  detection.
- Standard Unix daemon management: `kill -0 <pid>` or `/proc/<pid>/status`
  checks.

### Pros

- **Definitive for liveness.** If the process is gone, the agent is dead.
  No ambiguity.
- **Agent-agnostic.** Works with any process. No cooperation needed.
- **Cheap.** `ps` is fast and does not touch the terminal buffer.

### Cons

- **Binary signal only.** Alive or dead. Cannot distinguish working vs.
  waiting vs. needs_input.
- **TTY matching is fragile.** Shell wrappers, subprocesses, and agent
  auto-restart can change the process tree. Spur uses a regex on the args
  column rather than exact PID matching, which is more resilient but can
  false-positive on similarly-named processes.
- **Platform-dependent.** `ps` flags and TTY naming differ across macOS and
  Linux. Spur's `/dev/` prefix stripping works on both, but edge cases exist
  (e.g., containers with different `/dev/pts` numbering).
- **Race conditions.** The process can exit between the check and the
  subsequent action. Spur mitigates this by rechecking in retry loops.

---

## 5. JSONL Log Tailing

**How it works.** Some agents write conversation logs as JSONL files
(one JSON object per line). The orchestrator can tail these files, parse
events, and infer state from the event stream. Alternatively, it can check
file modification time (mtime) as a proxy for activity.

**Spur implementation.** Spur uses JSONL for its own event log
(`events.jsonl`) via `appendEventLog` / `readEventLog` in `event-log.ts`,
but this is the orchestrator's audit log, not the agent's. For Claude Code,
Spur reads the agent's JSONL session file to find the session ID
(`findLatestSessionFile` in `claude.ts` reads from
`~/.claude/projects/<project>/`), but does not tail it for real-time status.

The mtime approach was documented in Spur's competitive research as the
"JSONL mtime" pattern used by the legacy `claude-status` script.

**Real-world examples.**
- [clog (HillviewCap)](https://github.com/HillviewCap/clog): web viewer that
  watches Claude Code JSONL files for changes and live-updates the display.
- [agent-flow](https://github.com/patoles/agent-flow): VS Code extension
  that tails JSONL event logs and visualizes agent activity in real time.
- [ccusage](https://github.com/ryoppippi/ccusage): CLI tool that analyzes
  Claude Code JSONL logs for usage statistics.

### Pros

- **Rich event data.** JSONL entries contain tool calls, responses, token
  counts, and timing. Much more than binary state.
- **Historical.** Can replay past state, not just current. Useful for
  debugging and cost tracking.
- **Non-invasive.** File watching does not require any IPC with the agent.

### Cons

- **Latency.** File writes are buffered. There can be seconds between an
  agent action and the corresponding JSONL entry appearing on disk.
- **Format instability.** Agent JSONL formats are internal implementation
  details. Claude Code's JSONL schema has changed across versions.
- **File location discovery.** Finding the right JSONL file requires knowing
  the agent's project directory structure. Spur's `findLatestSessionFile`
  must resolve worktree path variants and sort by mtime.
- **Not designed for status.** JSONL logs record conversation events, not
  state transitions. Inferring "waiting" from "no new events in N seconds"
  is a heuristic, not a signal.
- **Disk I/O.** Tailing large JSONL files (Claude Code sessions can reach
  2GB) is expensive. Seeking to the end and reading backwards is possible
  but adds complexity.
- **mtime is coarse.** File modification time has second-level granularity
  on many filesystems. Not suitable for sub-second state detection.

---

## The "Prompt Is Always Visible" Problem

Modern TUI agents (Claude Code, Codex, Aider) render a persistent UI that
always shows an input prompt, even while the agent is working. This breaks
the classic heuristic of "prompt visible = idle."

**Why it happens.** TUI frameworks render the full UI chrome on every frame:
input field, status bar, separator lines. The prompt character is part of
the layout, not a state indicator. Codex always shows `›` whether idle or
working. Claude Code always shows `❯` but may also show it during tool
execution.

**How Spur handles it.** Multi-signal classification with priority ordering:

1. **Hooks first** (if fresh). `UserPromptSubmit` -> working (skip pane).
   `Stop` -> waiting (but still check pane for needs_input).
2. **Title second** (Codex only). Status keywords in pane title are
   definitive when present.
3. **Pane last** (fallback). Check `needs_input` patterns first (permission
   prompts, interview options, Codex question UI). Then check working
   indicators ("esc to interrupt"). Only after ruling those out, check for
   the prompt character as the last line -> waiting.

The key insight: **the prompt character on the last line is the weakest
signal and must be checked last.** Any stronger signal (hook, title keyword,
working indicator, permission prompt) overrides it.

**State debounce.** Even with multi-signal classification, rapid polls can
see transient states (e.g., the agent finishes a turn and the pane shows the
prompt for one frame before the next turn starts). Spur's `STATE_HOLD_MS`
(4 seconds) suppresses single-poll flicker: if the state changed within the
last 4 seconds and the new state is not a high-priority state (needs_input,
stopped, killed, error), the previous state is held.

---

## Best Practices for Combining Multiple Signals

### Priority waterfall

```
1. Process liveness (gate)       -> if dead: "stopped"
2. Hook state (authoritative)    -> if fresh working: "working" (done)
                                 -> if waiting: check pane for needs_input
3. Terminal title (structured)   -> if keyword present: use it (done)
4. Pane capture (fallback)       -> regex classification
5. State debounce (smoothing)    -> suppress transient flicker
```

### Design principles

1. **Authoritative signals override heuristic signals.** Hooks and title
   keywords are agent-reported; pane regex is observer-inferred. Always
   prefer the former.

2. **Freshness windows, not permanent trust.** A hook event saying "working"
   is only meaningful for a short window (Spur uses 2s). After that, the
   agent may have crashed silently. Fall back to pane capture.

3. **Always check for needs_input from pane.** No current hook system fires
   events for permission prompts or interactive questions. The pane is the
   only source for these states, even when hooks are authoritative for
   working/waiting.

4. **Strip UI chrome before classifying.** TUI apps add decorative lines,
   status bars, and update banners below content. Normalize pane output by
   removing known trailing patterns before checking the "last line."

5. **Debounce state transitions.** Hold the previous state for a few seconds
   before accepting a change. This prevents UI flicker during rapid
   transitions (agent finishing one turn and immediately starting another).

6. **Agent-specific classifiers.** Different agents have different TUI
   layouts and conventions. Spur has separate code paths for Claude Code
   (`classifyLivePaneState`) and Codex (`classifyCodexTitle` +
   `classifyCodexPane`). Do not try to unify them into one generic
   classifier.

7. **Fail toward working, not waiting.** If the classifier cannot determine
   state, assume "working." The cost of incorrectly showing "waiting" (user
   sends a message that queues or gets lost) is higher than incorrectly
   showing "working" (user waits a bit longer).

---

## Comparison Matrix

| Approach           | Latency | Reliability | Agent coupling | Rich state | needs_input |
|--------------------|---------|-------------|----------------|------------|-------------|
| Pane capture regex | ~10ms   | Medium      | None           | High       | Yes         |
| Terminal title     | ~5ms    | High        | High           | Low        | No          |
| Hook events        | ~1ms   | High        | High           | Medium     | No          |
| Process tree       | ~50ms   | High        | None           | None       | No          |
| JSONL log tailing  | ~1-5s   | Low         | Medium         | Very high  | No          |

### Most reliable for TUI apps that always render UI chrome

**Hook events + pane capture fallback.** Hooks solve the always-visible-prompt
problem by reporting actual state transitions. Pane capture fills the gap for
needs_input states that hooks cannot detect. This is the approach Spur uses
in production, and it is the most reliable combination tested across Claude
Code and Codex.

Terminal title is a strong secondary signal for agents that support it (Codex),
but cannot be the primary approach because not all agents set titles and the
signal vocabulary is limited.

Pure pane capture is the most universally applicable but least reliable for
TUI apps, because the always-visible-prompt problem creates a systematic
false "waiting" signal during active work.

Process tree inspection is essential as a liveness gate but provides no state
discrimination beyond alive/dead.

JSONL log tailing is best suited for offline analysis, cost tracking, and
debugging, not real-time status detection.

---

## Sources

- [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator) -- tmux plugin for visual agent state feedback
- [NTM (Named Tmux Manager)](https://github.com/Dicklesworthstone/ntm) -- multi-agent tmux orchestrator with status detection
- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) -- hook event tracking and visualization
- [agents-observe](https://github.com/simple10/agents-observe) -- real-time hook event streaming dashboard
- [clog](https://github.com/HillviewCap/clog) -- JSONL log viewer with file watching
- [agent-flow](https://github.com/patoles/agent-flow) -- JSONL event log visualization
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- Spur source: `v2/src/session-service.ts`, `v2/src/agent-hook-state.ts`, `v2/src/runtime-tmux.ts`, `v2/src/agents/claude.ts`, `v2/src/agents/codex.ts`
