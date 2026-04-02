# Research: Claude Code Status Detection in tmux Orchestrators

Two open-source projects that orchestrate Claude Code agents in tmux sessions and detect working/idle status.

---

## 1. nielsgroen/claude-tmux

**URL:** https://github.com/nielsgroen/claude-tmux
**Stars:** ~121
**Language:** Rust (ratatui TUI)
**Purpose:** tmux popup for managing multiple Claude Code sessions with status monitoring, git worktree, and PR support.

### Status Detection Approach

Uses `tmux capture-pane` to grab the last N lines (default 15, with empty lines stripped), then pattern-matches the captured text.

**State machine** (`src/session.rs`):

| State          | Symbol | Meaning                          |
|----------------|--------|----------------------------------|
| `Idle`         | `○`    | Waiting at prompt, ready for input |
| `Working`      | `●`    | Actively processing              |
| `WaitingInput` | `◐`    | Permission prompt (y/n)          |
| `Unknown`      | `?`    | Cannot determine                 |

**Detection algorithm** (`src/detection.rs`):

```rust
pub fn detect_status(content: &str) -> ClaudeCodeStatus {
    // Step 1: Detect input field by its visual structure
    if has_input_field(content) {
        // Step 2: Check if interruptable
        if content.contains("ctrl+c") && content.contains("to interrupt") {
            return ClaudeCodeStatus::Working;
        }
        return ClaudeCodeStatus::Idle;
    }

    // No input field - check for permission prompt
    if content.contains("[y/n]") || content.contains("[Y/n]") {
        return ClaudeCodeStatus::WaitingInput;
    }

    ClaudeCodeStatus::Unknown
}
```

### Handling the `❯` Input Field

This is the key insight. The `❯` prompt is always visible in Claude Code's TUI, so you cannot just check for its presence. Instead, they check for the **border line (`─`) directly above the prompt**:

```rust
fn has_input_field(content: &str) -> bool {
    let lines: Vec<&str> = content.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.contains('❯') {
            if i > 0 && lines[i - 1].contains('─') {
                return true;
            }
        }
    }
    false
}
```

Then they disambiguate idle vs working by checking for `"ctrl+c"` + `"to interrupt"` in the captured content. If the interrupt hint is present, Claude is working; otherwise it is idle.

### Debounce / Hysteresis

**None.** Detection is stateless and point-in-time. Each call to `detect_status` independently evaluates the current pane content. The TUI refreshes the session list on demand (manual `R` refresh or periodic poll in the UI loop).

### Capture Details

- Captures full pane with `capture-pane -p -J -e` (join wrapped lines, include ANSI escapes)
- Strips empty lines before taking the last N lines (for status detection)
- Preserves empty lines for preview display (different code path)
- Identifies Claude Code panes by checking `pane_current_command` for `"claude"`

---

## 2. primeline-ai/claude-tmux-orchestration

**URL:** https://github.com/primeline-ai/claude-tmux-orchestration
**Stars:** ~23
**Language:** Bash (pure shell scripts)
**Purpose:** Spawn Claude Code workers as parallel tmux windows with heartbeat monitoring, file-based coordination, and rate-limit recovery.

### Status Detection Approach

Uses `tmux capture-pane -p -S -12` (last 12 lines) piped through an ANSI-stripping `sed` filter, then matches against two pattern classes.

**Idle detection** (`heartbeat.sh`):

```bash
check_pane_idle() {
    local target="${1:-$ORCH_PANE}"
    local captured
    captured=$(tmux capture-pane -t "$target" -p -S -12 2>/dev/null | strip_ansi) || return 1

    # Spinner patterns = busy (check first, overrides idle)
    if echo "$captured" | grep -qE '(Running|thinking|Searching|Reading|Writing|Editing)'; then
        return 1
    fi

    # Idle patterns (Claude Code prompt characters)
    if echo "$captured" | grep -qE '(❯[\s ]*$|>\s*$|waiting for input|claude\s+code\s+v[0-9.]+|\$\s*$)'; then
        return 0
    fi

    # Unknown state — assume busy (safe default)
    return 1
}
```

**Boot detection** (`spawn-worker.sh`):

```bash
# Wait for Claude Code to reach idle state
if echo "$CAPTURED" | grep -qE '❯|>\s*$'; then
    if ! echo "$CAPTURED" | grep -qE '(Running|thinking|Searching)'; then
        BOOT_OK=true
        break
    fi
fi
```

### Handling the `❯` Input Field

Uses a **priority override** approach: check for "busy" spinner words first (`Running`, `thinking`, `Searching`, `Reading`, `Writing`, `Editing`). If any are present, the pane is busy regardless of whether `❯` is visible. Only if no busy indicators are found does it check for idle patterns (`❯` at end of line, bare `>` prompt, version string).

The boot-wait logic in `spawn-worker.sh` uses the same pattern: find `❯`, then verify no spinner words are present.

### ANSI Stripping

Critical preprocessing step before any pattern matching:

```bash
strip_ansi() {
    sed -E \
        -e 's/\x1b\[[0-9;:?<=>]*[a-zA-Z]//g' \
        -e 's/\x1b\][^\x07\x1b]*(\x07|\x1b\\)//g' \
        -e 's/\x1bP[^\x1b]*(\x1b\\|$)//g' \
        -e 's/\x1b[()][0-9A-Za-z]//g' \
        -e 's/[\x0e\x0f]//g'
}
```

Covers CSI (cursor/color), OSC (title/hyperlinks), DCS (device control), charset switches, and SI/SO control chars.

### Debounce / Hysteresis

**Adaptive heartbeat intervals** based on worker activity, not detection flicker:

| Condition                   | Interval |
|-----------------------------|----------|
| Worker stuck (stale >3 cycles) | 30s      |
| Active workers              | 120s     |
| No workers / all done       | 300s     |

**Rate-limit watchdog** (`rate-limit-watchdog.sh`) adds explicit debounce:
- Minimum 30s between triggers for the same session (`now - last < 30` guard)
- 65s cooldown after detecting a rate limit before attempting resume
- Exponential backoff after 5 consecutive retries (backoff = cooldown * 2 * retry_count, capped at 600s)
- Re-checks pane content after cooldown to see if the issue self-resolved

**Boot polling** uses 3s intervals with a 60s timeout. No exponential backoff; simple linear poll.

### File-Based Coordination

Workers write their own status to `_orchestrator/workers/<id>.json`. The heartbeat reads these files to determine the overall system state. This is a **push model** (workers declare their state) layered on top of the **pull model** (pane capture for idle detection). The heartbeat only sends commands to panes it detects as idle.

---

## Comparison

| Dimension                 | nielsgroen/claude-tmux            | primeline-ai/claude-tmux-orchestration |
|---------------------------|-----------------------------------|----------------------------------------|
| Detection method          | `capture-pane` + structural parse | `capture-pane` + regex grep            |
| Key idle signal           | `❯` with `─` border above it     | `❯` at line end, no spinner words      |
| Key working signal        | `"ctrl+c to interrupt"` present   | Spinner words: Running, thinking, etc. |
| Permission/input detect   | `[y/n]` or `[Y/n]` in content    | Not explicitly handled                 |
| ANSI handling             | Included in capture (`-e` flag), UI renders them | Stripped before matching (`sed` pipeline) |
| Debounce                  | None (stateless)                  | Adaptive intervals + rate-limit backoff |
| Architecture              | Single TUI binary, read-only      | Bash scripts, sends commands to panes  |
| False-positive strategy   | Default to `Unknown`              | Default to "busy" (safe, never sends to a working pane) |

---

## Bonus: haxybaxy/claude-tmux-status (Hook-Based Alternative)

**URL:** https://github.com/haxybaxy/claude-tmux-status (2 stars)

This project takes an entirely different approach: instead of scraping pane content, it uses **Claude Code's native hook system** to push state changes. No detection logic at all.

**Hooks registered:**

| Hook Event          | State set    |
|---------------------|-------------|
| `SessionStart`      | idle        |
| `UserPromptSubmit`  | processing  |
| `PreToolUse`        | processing  |
| `PostToolUse`       | processing  |
| `Stop`              | idle        |
| `PermissionRequest` | attention   |
| `Notification`      | attention   |
| `SessionEnd`        | (cleanup)   |

Each hook runs a bash script that renames the tmux window with a state icon suffix (e.g., `zsh [🧑‍🍳]`). This is 100% accurate (no scraping ambiguity) but only works when you control the Claude Code launch configuration and can register hooks. It cannot detect status of externally launched Claude Code instances.

---

## Takeaways for Spur

1. **Pane scraping is fragile.** Both scraping projects use different heuristics and neither is fully robust. The `❯` prompt is always visible, so bare presence is not enough.
2. **Best scraping signal:** border line (`─`) directly above `❯` indicates the input field is visible, then check for `"ctrl+c to interrupt"` to distinguish working from idle.
3. **ANSI stripping is mandatory** when doing regex matching on `capture-pane` output.
4. **Hooks are the clean path.** If you control the agent launch, Claude Code hooks (`Stop`, `UserPromptSubmit`, etc.) give exact state without scraping. Spur already controls the launch and could register hooks at spawn time.
5. **Safe default:** When status is ambiguous, assume "busy" (primeline-ai approach). Never send input to a pane that might be working.
6. **Adaptive polling** (primeline-ai) is better than fixed-interval polling for long-running orchestration.
