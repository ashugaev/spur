# Research: Solving Status Flickering When Monitoring TUI Applications via tmux capture-pane

## Problem Statement

When an orchestrator polls `tmux capture-pane` to classify agent state (working/waiting/needs_input), the displayed status flickers between states. The user sees rapid toggling -- e.g., "working" for one poll, "waiting" the next, then "working" again -- even though the agent's true state hasn't changed.

---

## 1. Projects That Had and Solved Flickering

### Spur (this project)

Spur's `session-service.ts` classifies agent state by reading tmux pane content and hook state files. Three PRs addressed progressive layers of flickering:

- **PR #62**: Hook directory was never created, so hook state was always null and pane classification ran every poll. Also: when the Stop hook fired "waiting", pane classification could still return "working" because the terminal hadn't rendered the new prompt yet (~100ms lag).
- **PR #64**: Line-wrapped `@clack/prompts` text broke regex matching (interview escape pattern split across two lines). Codex interactive question UI matched "esc to interrupt" before the question pattern, returning "working" instead of "needs_input".
- **PR #65**: Added a 4-second state debounce hold window. Transient single-poll disagreements are suppressed; the cached state wins until the hold expires. Transitions to `needs_input`, `stopped`, `killed`, and `error` bypass the hold immediately.

### tmux-agent-status (samleeney)

Plugin for showing Claude Code working/idle state in the tmux status bar. Uses Claude Code hooks (UserPromptSubmit, PreToolUse, Stop, Notification) to write state files (`~/.cache/tmux-agent-status/<session>.status`). Polls status files at 1-second intervals. The hook-driven architecture avoids capture-pane entirely for primary state, eliminating the capture timing race.

### tmux-agent-indicator (accessd)

Tmux plugin providing pane border colors and status icons for running/needs-input/done states. State transitions are driven entirely by hooks rather than pane polling. Status colors reset only on pane focus or next hook transition, preventing visual chatter from unnecessary state updates.

### agent-tmux-monitor (damelLP)

Rust tool with multi-layer state detection. Uses pane output hashing: captures pane content, hashes it, and if the hash is unchanged across multiple poll cycles, classifies the agent as idle. Also monitors Claude Code session files (`~/.claude/projects/<project>/<session>/`) for activity that doesn't appear in terminal output (e.g., agent writing a large file with a static pane for 20 seconds). Updates via hooks every ~300ms.

### agent-viewer (hallucinogen)

Web-based kanban board for Claude agents in tmux. Polls tmux pane output every 3 seconds. Sorts agents into Running/Idle/Completed columns. No documented anti-flicker mechanism beyond the relatively long poll interval (3s naturally dampens rapid state changes).

### ccmanager (kbwo)

CLI session manager for Claude Code, Gemini CLI, Codex CLI, and others. Has a "state detection strategy" feature that adapts to each CLI tool's unique output patterns. Fires status hooks when sessions enter Idle/Waiting/Busy, enabling automation. Supports custom pattern configuration per agent type.

### vterm-anti-flicker-filter (martinbaillie)

Emacs vterm plugin. Detects redraw patterns in terminal output (3+ escape sequences in a single output chunk) and buffers output briefly before rendering. Presents a cohesive frame rather than intermediate redraw states. This is output-side buffering rather than polling-side debounce.

### tmai (trust-delta)

Tmux Multi Agents Interface. Uses a 3-tier state detection with automatic fallback: Hooks (HTTP) > IPC (PTY wrap) > capture-pane. Higher tiers are authoritative; capture-pane is the lowest-confidence fallback.

### Batty (battyterm)

Rust daemon that orchestrates AI agents in tmux. Polls every 5 seconds with synchronous polling. Each poll runs the same checks in the same order. The 5-second interval is deliberately slow because tmux commands complete in 1-5ms and the extra granularity isn't needed.

### Powerline tmux status

Powerline experienced status bar blinking when running shell integration with tmux. The blink occurred on every directory change. Not a capture-pane issue per se but the same visual symptom. Solutions were mostly configuration fixes (256-color, true color, environment variables) rather than debounce.

### Claude Code itself

Claude Code's TUI caused 4,000-6,700 scroll events/second in tmux, causing severe jitter. Fixed with synchronized output (DEC mode 2026): wrapping output in sync markers so tmux renders atomically. Also shipped a differential renderer that reduced flickers by ~85%, and later a NO_FLICKER mode. The `claude-chill` wrapper by davidbeesley intercepts sync blocks and uses a VT100 emulator to diff screen state.

---

## 2. Root Causes of Flickering

### 2a. Partial Renders (Terminal Rendering Lag)

When an agent transitions state (e.g., finishes a task), the terminal prompt does not appear atomically. The agent process writes output, the terminal emulator processes escape sequences, and tmux's internal screen buffer updates asynchronously. A `capture-pane` call during this window sees an intermediate state -- the old content is partially overwritten but the new prompt hasn't rendered yet.

**Measured lag**: Spur found ~100ms between a hook event firing and the pane content reflecting the new state.

### 2b. Race Conditions Between Hooks and Pane State

When using hooks (e.g., Claude Code's Stop hook) alongside pane classification, the hook can signal "waiting" while the pane still shows working output. If the system checks both sources and the pane wins, it reverts to "working" for one poll cycle.

### 2c. Regex Sensitivity to Layout

TUI applications reflow text based on terminal width. A regex that matches `Esc to cancel` on one line fails when the terminal wraps it as `Esc to\ncancel`. This causes classification to flip between states depending on terminal geometry or content length.

### 2d. Ambiguous TUI Patterns

Some TUI elements appear in multiple states. Codex shows "esc to interrupt" in both its working spinner AND its interactive question UI. Without careful ordering of pattern checks, the classifier can misidentify the state.

### 2e. High-Frequency Output During Processing

Agents that stream output (token-by-token rendering) produce thousands of screen updates per second. If the poller happens to capture during a streaming burst, the content differs from the previous capture even though the logical state hasn't changed.

### 2f. tmux Command Sequencing

`tmux capture-pane` is a separate subprocess invocation. There is no synchronization guarantee between the capture and the pane's current render state. The `display-pane` + `capture-pane` sequencing issue (tmux issue #1412) documents that buffers may not be filled before the read occurs.

---

## 3. Solutions

### 3a. Debounce Timer (State Hold Window)

**Pattern**: Cache the last classified state with a timestamp. If the new classification disagrees with the cached state and the cache is younger than a threshold, suppress the new state and return the cached one.

**Spur's implementation** (`STATE_HOLD_MS = 4_000`):
```
if (cached && state !== cached.state && now - cached.classifiedAt < STATE_HOLD_MS) {
  if (state is not a terminal/urgent state) {
    state = cached.state;  // suppress transient
  }
}
```

**Key design choice**: Urgent states (`needs_input`, `stopped`, `killed`, `error`) bypass the hold immediately. Only "soft" transitions (working <-> waiting) are debounced.

**Trade-off**: Adds up to N seconds of latency before a genuine state change is reflected. Spur uses 4s, which is acceptable because the list UI polls at 1-2s intervals and a 4s delay in showing "waiting" vs "working" is imperceptible to users.

### 3b. Hook-Driven State (Push, Not Poll)

**Pattern**: Instead of inferring state from pane content, have the agent report its own state transitions via hooks/callbacks that write to a file or HTTP endpoint.

**Projects using this**: tmux-agent-status, tmux-agent-indicator, Spur (agent-hook-state), tmai (HTTP hooks).

**Spur's implementation**: Claude Code hooks write `{state: "working"|"waiting", updatedAt, hookEvent}` to a JSON file. The poller reads this file first. If the hook state is fresh (within `HOOK_FRESHNESS_MS = 2_000`), it trusts the hook and skips pane classification entirely.

**Trade-off**: Requires agent-side integration. Not all agents support hooks. Spur treats hook state as authoritative for "working" (fresh UserPromptSubmit) but still checks the pane for "waiting" hook state because `needs_input` requires terminal interaction the agent can't signal.

### 3c. Tiered Detection with Fallback

**Pattern**: Use multiple detection sources ranked by confidence. Only fall through to lower-confidence sources when higher ones are unavailable or stale.

**tmai's 3-tier approach**: Hooks (HTTP) > IPC (PTY wrap) > capture-pane.

**Spur's approach**: Hook fresh-working (2s) > Hook waiting + pane needs_input check > Full pane classification.

**Trade-off**: More complex code. Each tier has different latency and reliability characteristics.

### 3d. Hash-Based Idle Detection (Content Fingerprinting)

**Pattern**: Hash the captured pane content. If the hash is unchanged across N consecutive polls, classify as idle/waiting. If changing, classify as working.

**Projects using this**: agent-tmux-monitor (damelLP).

**Advantage**: Doesn't depend on regex patterns that break with layout changes. Works for any TUI.

**Trade-off**: Can't distinguish between "idle" and "waiting for input" -- both have static panes. Also can't detect state changes that don't alter visible content (e.g., background file writes).

### 3e. Title-Based Detection

**Pattern**: TUI applications often set the terminal title (via OSC escape sequences) to reflect state. `tmux display-message -p "#{pane_title}"` is faster and more reliable than full pane capture.

**Spur's Codex implementation**: Codex sets title to `"session-name"` (idle), `"spinner session-name"` (active), or `"spinner session-name . Ready"` (waiting). Title check runs before pane capture; if conclusive, pane capture is skipped.

**Trade-off**: Only works for agents that set meaningful titles. Claude Code does not use terminal titles for state.

### 3f. Synchronized Output (DEC Mode 2026)

**Pattern**: The TUI application wraps its output in sync markers (`\e[?2026h` ... `\e[?2026l`). The terminal buffers all output between markers and renders atomically in a single
 frame.

**Projects**: Claude Code itself, with patches accepted to tmux and VSCode terminal.

**Effect on monitoring**: If tmux supports synchronized output, `capture-pane` always sees a complete frame, never a partial render. Eliminates root cause 2a entirely.

**Trade-off**: Requires both the application and terminal to support the protocol. Does not help with root causes 2b-2e.

### 3g. Output Buffering / Frame Coalescing

**Pattern**: Buffer terminal output for a short window (e.g., 16ms for ~60fps) and flush as a single batch. The monitor sees coherent frames.

**Projects**: claude-chill (VT100 emulator diffing), vterm-anti-flicker-filter (escape sequence pattern detection).

**Trade-off**: Adds latency to terminal rendering. Only helps the output side, not the polling side.

---

## 4. The "Multi-Sample Consensus" Pattern

Borrowed from embedded systems button debouncing. The core rule: **accept a state transition only after N consecutive polls return the same new state**.

### Embedded Systems Origin

Hardware button debouncing uses this pattern extensively:
- Sample the input at fixed intervals (10-25ms typical)
- Push each sample into a shift register or counter
- Only register a state change when N consecutive samples agree

### Implementations

**Shift register technique**: Maintain a bitmask of the last N samples. AND or OR the register to check for unanimous agreement. For example, with 8 samples: `if (register == 0xFF) state = HIGH; else if (register == 0x00) state = LOW;`.

**Counter technique**: Increment a counter when the new reading disagrees with current state. Reset to 0 when it agrees. Transition when counter reaches threshold N.

**State machine technique**: IDLE -> BOUNCING -> STABLE. Enter BOUNCING on first disagreement. Return to IDLE if agreement resumes within the window. Transition to STABLE (and update state) after N consecutive disagreements.

### Application to TUI Monitoring

A direct translation for tmux pane polling:
```
const CONSENSUS_REQUIRED = 3;
let candidateState = null;
let candidateCount = 0;

function onPoll(newState) {
  if (newState === currentState) {
    candidateState = null;
    candidateCount = 0;
    return currentState;
  }
  if (newState === candidateState) {
    candidateCount++;
    if (candidateCount >= CONSENSUS_REQUIRED) {
      currentState = newState;
      candidateState = null;
      candidateCount = 0;
    }
  } else {
    candidateState = newState;
    candidateCount = 1;
  }
  return currentState;
}
```

**Difference from Spur's time-based debounce**: Spur uses a time window (4s). The consensus pattern uses a count window (N polls). With a 1s poll interval and N=3, the consensus pattern gives 3s of debounce. The count-based approach is independent of poll frequency changes.

**Not used in any surveyed project** for tmux monitoring. All surveyed projects use either time-based debounce, hooks, or no debounce at all.

---

## 5. The "State Stickiness" Pattern

**Pattern**: Use different thresholds for different transitions. Some transitions are easy to enter and hard to leave; others are the reverse.

### Directional Asymmetry

The key insight: not all state transitions are equally costly to get wrong.

- **False "needs_input"**: User gets a spurious notification. Annoying but not harmful.
- **False "working" when actually waiting**: User doesn't know the agent is idle. Wastes time.
- **False "waiting" when actually working**: Benign. The status will correct on next poll.

This suggests asymmetric thresholds:
- `working -> waiting`: Require 2-3 consecutive "waiting" readings (debounce to avoid false idle)
- `waiting -> working`: Accept immediately (any sign of activity is worth showing)
- `* -> needs_input`: Accept immediately (user action required, minimize delay)
- `* -> stopped/killed/error`: Accept immediately (terminal states, never suppress)

### Spur's Partial Implementation

Spur implements a version of this: `needs_input`, `stopped`, `killed`, and `error` bypass the debounce hold entirely, while `working` and `waiting` are subject to the 4s hold. This is directional stickiness -- terminal/urgent states punch through, soft states are dampened.

### Hysteresis

The embedded systems term for this is **hysteresis**: different thresholds for rising vs falling transitions. A thermostat turns on at 68F but doesn't turn off until 72F, preventing rapid cycling around the setpoint.

Applied to TUI monitoring: the "turn off" threshold (leaving a state) is higher than the "turn on" threshold (entering it), specifically for states where false transitions are expensive.

---

## 6. Novel Approaches

### Session File Activity Monitoring (agent-tmux-monitor)

Monitor the agent's session files (`~/.claude/projects/...`) for write activity. If the session file is growing, the agent is working -- even if the pane content is static. This catches cases where an agent writes a large file without updating the terminal for 20+ seconds.

### VT100 Emulator Diffing (claude-chill)

Instead of regex-matching raw pane output, run it through a VT100 state machine to get the rendered screen state. Diff the rendered screen against the previous frame. Only propagate changes when the diff is meaningful. This eliminates false transitions caused by escape sequence timing (cursor movements, color resets) that don't change visible content.

### 3-Tier Confidence Cascade (tmai)

Assign confidence scores to each detection tier. Use the highest-confidence source available. When multiple sources agree, increase confidence. When they disagree, use the higher-tier source but flag the disagreement for debugging. This is effectively weighted voting.

### Pane Title as Primary Signal (Spur + Codex)

When an agent sets its terminal title to reflect state (Codex does this with braille spinners and status words), use the title as the primary signal. Title changes are atomic (single escape sequence) and don't suffer from partial-render races. Pane capture is only needed as fallback for agents that don't set titles.

### Slow Poll with Fast Event Path

Batty's approach: poll slowly (5s) for baseline monitoring, but react instantly to hook events. The slow poll is just a consistency check; the hook is the real signal. This minimizes subprocess overhead while maintaining responsiveness.

---

## Sources

- [tmux/tmux#2901 - Sync flicker in nested tmux](https://github.com/tmux/tmux/issues/2901)
- [tmux/tmux#1012 - Multiple panes and flickering](https://github.com/tmux/tmux/issues/1012)
- [tmux/tmux#1412 - Sequencing problem between display-pane+capture-pane](https://github.com/tmux/tmux/issues/1412)
- [forge-agents/agate#3 - Terminal flickering when running Claude Code](https://github.com/forge-agents/agate/issues/3)
- [anthropics/claude-code#9935 - Excessive scroll events causing UI jitter](https://github.com/anthropics/claude-code/issues/9935)
- [anthropics/claude-code#1913 - Terminal Flickering](https://github.com/anthropics/claude-code/issues/1913)
- [steipete/tmuxwatch - TUI to watch tmux sessions](https://github.com/steipete/tmuxwatch)
- [samleeney/tmux-agent-status - Hook-driven agent status](https://github.com/samleeney/tmux-agent-status)
- [accessd/tmux-agent-indicator - Pane border state indicators](https://github.com/accessd/tmux-agent-indicator)
- [trust-delta/tmai - 3-tier state detection](https://github.com/trust-delta/tmai)
- [Dicklesworthstone/claude_code_agent_farm - 20+ agent orchestration](https://github.com/Dicklesworthstone/claude_code_agent_farm)
- [hallucinogen/agent-viewer - Kanban board for tmux agents](https://github.com/hallucinogen/agent-viewer)
- [damelLP/agent-tmux-monitor - Hash-based idle detection](https://github.com/damelLP/agent-tmux-monitor)
- [kbwo/ccmanager - Multi-agent session manager](https://github.com/kbwo/ccmanager)
- [nielsgroen/claude-tmux - Tmux popup session manager](https://github.com/nielsgroen/claude-tmux)
- [martinbaillie/vterm-anti-flicker-filter - Emacs vterm buffering](https://github.com/martinbaillie/vterm-anti-flicker-filter)
- [davidbeesley/claude-chill - VT100 diffing wrapper](https://github.com/davidbeesley/claude-chill)
- [battyterm - Rust tmux agent supervisor](https://dev.to/battyterm/building-a-tmux-native-agent-supervisor-in-rust-5hek)
- [Bubbletea State Machine pattern](https://zackproser.com/blog/bubbletea-state-machine)
- [Ratatui - Elm Architecture for TUIs](https://ratatui.rs/concepts/application-patterns/the-elm-architecture/)
- [Embedded debouncing - Ganssle](https://www.ganssle.com/debouncing-pt2.htm)
- [Embedded debouncing - Digikey](https://www.digikey.com/en/maker/tutorials/2024/how-to-implement-a-software-based-debounce-algorithm-for-button-inputs-on-a-microcontroller)
- [Embedded debouncing patterns](https://www.embedded.com/my-favorite-software-debouncers/)
- [Claude Code terminal rendering rewrite (Threads)](https://www.threads.com/@boris_cherny/post/DSZbZatiIvJ)
- [Anthropic NO_FLICKER mode](https://piunikaweb.com/2026/04/02/anthropic-no-flicker-mode-claude-code/)
- [Claude Code flickering in tmux](https://blog.tymek.dev/claude-code-flickering-in-tmux/)
- [powerline/powerline#637 - Status bar blinking](https://github.com/powerline/powerline/issues/637)
