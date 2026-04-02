# Research: tmux plugins for AI agent state detection

Date: 2026-04-02

## 1. tmux-agent-indicator

**URL:** https://github.com/accessd/tmux-agent-indicator

### How it detects agent state

Hook-first architecture with process-detection fallback. No terminal output parsing.

**Primary: agent lifecycle hooks.** Each agent fires explicit hooks that call `scripts/agent-state.sh --agent <name> --state <running|needs-input|done|off>`. The script writes state into tmux environment variables (`TMUX_AGENT_PANE_{id}_STATE`, `TMUX_AGENT_PANE_{id}_AGENT`) and applies visual changes (pane border color, background, window title style).

Hook mappings per agent:

| Agent | Hook mechanism | Events mapped |
|-------|---------------|---------------|
| Claude Code | `~/.claude/settings.json` hooks | `UserPromptSubmit` -> running, `PermissionRequest` -> needs-input, `Stop` -> done |
| Codex | `~/.codex/config.toml` notify | Notify command -> done |
| OpenCode | Plugin event system | Plugin fires state transitions |
| Custom | Direct `agent-state.sh` calls | Wrapper scripts call with `--state` flag |

**Fallback: process detection.** When hooks are unavailable, `indicator.sh` checks for running processes listed in `@agent-indicator-processes` (default: `claude,codex,aider,cursor,opencode`). This only detects presence/absence -- it cannot distinguish running from needs-input.

### TUI framework handling

**Not addressed.** The plugin never reads terminal output or runs `capture-pane`. It is entirely event-driven (hooks) or process-presence-driven (fallback). TUI chrome (Ratatui, clack, Ink) is irrelevant because the plugin never parses what is rendered on screen.

### Distinguishing "thinking" from "idle at prompt"

The three-state model (`running`, `needs-input`, `done`) maps to agent lifecycle hooks, not to internal reasoning states. There is no distinction between "agent is thinking" and "agent is executing a tool" -- both are `running`. The transition to `done` happens when the agent fires its stop/completion hook. If an agent is idle at its prompt but has not fired a stop hook, it stays in whatever state was last set.

For Claude Code, `Stop` fires when the agent finishes a turn, so idle-at-prompt registers as `done`. For Codex, only the notify callback fires (on turn complete), so idle-at-prompt is also `done`. The gap is agents that do not fire hooks at all -- they fall through to process detection, which can only report binary alive/dead.

### Anti-flicker / debounce

Two mechanisms:

1. **Deferred reset on focus (`@agent-indicator-reset-on-focus`).** When enabled, `done` and `needs-input` visual states persist until the user focuses the pane. The `pane-focus-in.sh` hook clears state and restores original window/border styles only on focus. This prevents the common flicker pattern where an agent transitions rapidly through states (e.g., done -> running -> done) while the user is looking at a different pane.

2. **Animation lifecycle management.** The `running` state launches a background "Knight Rider" animation process (`animation.sh`) that bounces a frame index 0-6-0, writing to `TMUX_AGENT_ANIMATION_FRAME` and calling `tmux refresh-client -S` each tick. The animation self-terminates when no pane has `_STATE=running` in tmux env. Speed is configurable via `@agent-indicator-animation-speed` (default 300ms). State transitions kill the animation PID explicitly before starting a new visual state.

No time-based debounce (e.g., "ignore transitions within N ms"). Flicker prevention is structural: visuals are sticky until user attention (focus) or the next meaningful state transition.

---

## 2. tmux-agent-status

**URL:** https://github.com/samleeney/tmux-agent-status

### How it detects agent state

File-based state with hook-driven writes and process-polling fallback. No terminal output parsing.

**Primary: hooks write status files.** `hooks/better-hook.sh` (Claude) and `hooks/codex-notify.sh` (Codex) write state strings to flat files under `~/.cache/tmux-agent-status/`.

Two levels of status files:
- **Session-level:** `~/.cache/tmux-agent-status/{session}.status` -- aggregated state across all panes in the session.
- **Pane-level:** `~/.cache/tmux-agent-status/panes/{session}_{pane}.status` -- per-pane state.

The session-level status is derived: if any pane is `working`, session is `working`; else if any pane is `wait`, session is `wait`; else `done`.

Hook event mappings for Claude (`better-hook.sh`):

| Hook event | Written state | Side effects |
|------------|--------------|--------------|
| `UserPromptSubmit` | `working` | Clears wait timer, unparks session |
| `PreToolUse` | `working` | Clears wait timer (does NOT unpark) |
| `Stop` | `done` | Plays notification sound |
| `Notification` | (varies) | Handles sub-events |

For Codex (`codex-notify.sh`): only receives the turn-complete notify callback, writes `done`. The `working` state for Codex is detected via process polling.

**Fallback: process polling for Codex.** `scripts/lib/agent-processes.sh` builds a PID-to-children map via `ps -eo pid=,ppid=,args=`, then does BFS from each tmux pane's PID to find descendant processes matching `claude|codex`. For Codex specifically, it walks the process tree to the deepest codex PID and checks whether that PID has spawned child processes (sandbox/tool execution). If children exist, session is `working`; otherwise `done`.

Key detail: process polling is a **bootstrap fallback only**. Once hook-managed pane-level status files exist for a session, polling is skipped entirely (`session_has_pane_status` guard).

### TUI framework handling

**Not addressed.** Like tmux-agent-indicator, this tool never runs `capture-pane` or parses terminal content. All state comes from hook callbacks or process tree inspection. The rendered TUI is never examined.

### Distinguishing "thinking" from "idle at prompt"

Four states: `working`, `done`, `wait`, `parked`.

- `working` = agent is actively processing (hook fired `UserPromptSubmit` or `PreToolUse`, or process polling found active children).
- `done` = agent finished its turn (hook fired `Stop`, or Codex notify callback, or process has no active children).
- `wait` = timed wait mode for triaging. User-initiated via a wait command; expires after a timer (`$STATUS_DIR/wait/{session}.wait` contains Unix timestamp). The `check_wait_timers` function in `status-line.sh` expires wait states.
- `parked` = user-suspended session, excluded from summaries. Only `UserPromptSubmit` (explicit user interaction) unparks.

There is no "thinking" vs "idle at prompt" distinction. Both map to either `working` (if the agent hasn't fired Stop yet) or `done` (if it has). The Codex process-polling heuristic is the closest thing: it checks whether the deepest codex process has spawned children, which roughly maps to "executing a tool" vs "idle/thinking." But this is a process-tree heuristic, not a terminal-output analysis.

### Anti-flicker / debounce

1. **Session-level aggregation.** Individual pane state changes are rolled up to session level. A session only transitions to `done` when ALL panes are done. This naturally dampens flicker from individual panes cycling.

2. **Sidebar collector daemon.** `sidebar-collector.sh` runs as a singleton per tmux server, polling every 1 second. It serializes state to a cache file (`~/.cache/tmux-agent-status/.sidebar-cache`) using atomic `mv`. Status line renderers read from the cache, not from individual status files. The 1-second poll interval acts as implicit debounce -- rapid sub-second state transitions are coalesced into whatever state is current at the next tick.

3. **Change detection.** The collector tracks `_COLLECT_CHANGED` and only rewrites the cache when data actually changes, avoiding unnecessary tmux refreshes.

4. **Wait timer expiry.** Wait states have explicit Unix-timestamp expiry checked in `check_wait_timers()`, preventing stale wait indicators.

No explicit debounce delay on hook writes. The hooks write immediately to status files. Flicker dampening comes from the 1-second collector poll and the session-level aggregation.

---

## Comparative summary

| Aspect | tmux-agent-indicator | tmux-agent-status |
|--------|---------------------|-------------------|
| Primary detection | Hooks -> tmux env vars | Hooks -> flat status files |
| Fallback detection | Process name matching | Process tree BFS + child inspection |
| Terminal output parsing | None | None |
| TUI framework handling | N/A (never reads screen) | N/A (never reads screen) |
| States | running, needs-input, done, off | working, done, wait, parked |
| Thinking vs idle | Not distinguished | Not distinguished (Codex child-process heuristic is closest) |
| Anti-flicker | Deferred reset on pane focus | 1s collector poll + session aggregation |
| Multi-pane | Per-pane state in tmux env | Per-pane files, rolled up to session |
| Agents | Claude, Codex, OpenCode, custom | Claude, Codex, custom via status files |
| Language | Bash | Bash |

## Key takeaway for Spur

Neither project parses terminal output. Both treat the agent as a black box that fires hooks or runs as a detectable process. This is the pragmatic approach -- terminal output parsing is fragile (TUI redraws, ANSI escapes, framework chrome) and unnecessary when agents provide lifecycle hooks. The interesting difference is fallback strategy: tmux-agent-indicator does simple process-name matching, while tmux-agent-status does process-tree walking to infer whether an agent is actively executing tools (has children) vs idle (no children).

For Spur's `working-state` detection, the implication is: rely on Claude Code hooks and Codex notify as primary signals; use process-tree child inspection as the fallback heuristic for "is the agent doing work"; do not attempt `capture-pane` regex matching.
