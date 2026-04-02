# Research: Open-Source Claude Code Session Monitors

Two projects that manage multiple Claude Code sessions and parse terminal output
to determine agent state via `tmux capture-pane`.

---

## 1. dmux (standardagents/dmux)

**URL:** https://github.com/standardagents/dmux (1,323 stars)

**What it is:** A dev agent multiplexer for git worktrees and coding agents. Runs
multiple Claude Code (and other agent) sessions in tmux panes and monitors their
state in real time through a React-based TUI.

### How they parse Claude Code's TUI output

**Capture layer** (`src/utils/paneCapture.ts`):
- Uses `tmux capture-pane -t '<paneId>' -p -J -S -<lines>` every ~1 second.
- The `-J` flag joins wrapped lines so width-only pane resizes do not look like
  new content to the status detector.
- Captures 50 lines by default; retries with progressively larger windows (up to
  200 lines) when trailing blank lines consume the initial capture.
- Trims trailing blank lines before returning.

**Two-tier state detection** (heuristic + LLM):

1. **Fast heuristic tier** (`src/utils/paneAttentionHeuristics.ts`):
   - `hasAgentWorkingIndicators()` checks the bottom 10 lines for:
     - `"esc to interrupt"` / `"esc to cancel"` -- always means working.
     - Spinner-prefixed progress lines: regex `^[spinner_chars]\s*<word>` where
       spinner chars include `[U+2801-U+28FF] (braille), ◐◓◑◒◴◷◶◵, ●○◦•·⋯⋮, ✦✧✶✻✽, ⏳⌛`.
     - Progress words: `working, thinking, planning, pondering, crunching,
       analyzing, building, testing, running, searching, reviewing,
       understanding, loading, processing, writing, reading, editing, patching,
       generating, reasoning, compiling, indexing, summarizing, executing,
       refactoring, fixing, checking, scanning`.
     - Claude-specific patterns: `"claude is working"`, creative gerunds
       (`germinating, thinking, planning, ...`) ending in `...` or `...`.
   - `isLikelyUserTyping()` detects when changes are confined to a trailing
     prompt block (lines matching `> `, `$ `, `❯ `, `› ` and their `│`-prefixed
     variants) and the non-prompt prefix is stable. Prevents treating user input
     as agent activity.

2. **LLM analysis tier** (`src/services/PaneAnalyzer.ts`):
   - Only triggered when the terminal is static (heuristic tier found no working
     indicators) and content has not changed for several polling cycles.
   - Sends the last 50 trimmed lines to OpenRouter (Gemini Flash / Grok / GPT-4o
     Mini, raced in parallel via `Promise.any`).
   - Stage 1: classify as `in_progress`, `option_dialog`, or `open_prompt`.
   - Stage 2: if `option_dialog`, extract question/options/risk assessment.
   - Stage 3: if `open_prompt`, extract summary of what the agent just did.
   - Results cached by content MD5 hash (5s TTL), with request deduplication per
     pane+hash to prevent concurrent LLM calls for the same content.

**Worker architecture** (`src/workers/PaneWorker.ts`):
- Each pane gets a dedicated Worker thread polling at 1s intervals.
- Maintains a rolling 5-capture history; requires 3+ captures before making
  decisions.
- State machine: `working` -> (static detected) -> `analyzing` -> `idle`|`waiting`.
- Transitions back to `working` whenever `hasAgentWorkingIndicators()` fires or
  the capture fingerprint changes.
- After user typing is detected, waits 3.5s settle time before re-evaluating.
- After agent activity, waits 1.5s settle time.
- Once LLM classifies the pane as `idle` or `waiting`, sets
  `settledStateConfirmed = true` to block repeated LLM requests until new
  activity resumes.

### Spinner character handling

Defined in `SPINNER_PREFIX` regex:
```
[U+2801-U+28FF  ◐◓◑◒◴◷◶◵  ●○◦•·⋯⋮  ✦✧✶✻✽  ⏳⌛]
```
Used in a compound regex: spinner char + whitespace + progress word. This
catches both Claude Code's built-in spinners and other agents' progress
indicators.

### UI chrome stripping

dmux does NOT strip Claude's UI chrome (separator lines, status bar `⏵⏵`,
input field `❯`). Instead:
- The heuristic tier works on the raw last-10-20 lines and looks for positive
  working indicators. UI chrome is noise that simply does not match working
  patterns.
- The LLM tier receives the raw last-50 lines with instructions to focus on the
  bottom 10 lines. The LLM is told that `⏵⏵ accept edits on` without
  `"esc to interrupt"` is a static UI element, not progress.
- Prompt characters (`> `, `$ `, `❯ `, `› `) are recognized by the user-typing
  detector to distinguish human input from agent output.

### Anti-flicker patterns

1. **Activity fingerprint** (`buildPaneActivityFingerprint`): takes the last 12
   lines, trims trailing whitespace per line, and joins. Only changes within
   this window count as activity; top-of-buffer scroll is ignored.
2. **Capture history rolling window**: 5-sample history; requires all 5 to be
   identical before declaring "static". Any change resets the window.
3. **Settle timers**: 3.5s after user typing, 1.5s after agent activity, before
   triggering LLM analysis.
4. **`settledStateConfirmed` flag**: once LLM decides idle/waiting, no further
   LLM calls until the heuristic tier detects new activity.
5. **5s minimum between LLM calls** per pane regardless of content changes.
6. **Content-hash cache** on LLM results: if the same 50-line snapshot appears
   again within 5s, returns cached result without an API call.
7. **`-J` flag on capture-pane**: joins wrapped lines so terminal width changes
   alone do not look like new content.

---

## 2. oh-my-claudecode (Yeachan-Heo/oh-my-claudecode)

**URL:** https://github.com/Yeachan-Heo/oh-my-claudecode (21,613 stars)

**What it is:** Teams-first multi-agent orchestration for Claude Code. Spawns
multiple Claude Code workers in tmux panes, coordinates tasks via file-based
state (heartbeats, task files, outbox JSONL), and monitors worker health.

### How they parse Claude Code's TUI output

**Capture layer** (`src/team/tmux-session.ts`, `src/team/idle-nudge.ts`):
- `capturePane(paneId)` calls `tmux capture-pane -t <paneId> -p -S -80` (80
  lines of history).
- No `-J` flag; no blank-line trimming in the capture function itself.

**Pure-heuristic state detection** (no LLM):

Two functions classify pane state:

1. `paneHasActiveTask(captured)` -- returns true when the pane shows:
   - `"esc to interrupt"` (case-insensitive) in the tail 40 lines.
   - `"background terminal running"` in the tail 40 lines.
   - Lines matching Claude Code's spinner+gerund pattern:
     `^[·✻]\s+<Word>(<Word>){0,3}(…|...)$`
     -- only matches `·` (middle dot) and `✻` (heavy asterisk) as spinner
     prefixes, followed by 1-4 capitalized words ending in ellipsis.

2. `paneLooksReady(captured)` -- returns true when:
   - The last non-blank line starts with `›`, `>`, or `❯` (prompt characters).
   - OR any line in the capture contains `❯` (Claude prompt) or `›` (Codex
     prompt).
   - AND `paneIsBootstrapping()` is false (not in initial startup).

**Idle = ready AND NOT active task.** The `NudgeTracker` polls worker panes
every 5 seconds, and if a pane has been idle for 30s (configurable), sends a
continuation message via `tmux send-keys`.

**Rate-limit detection** (`src/features/rate-limit-wait/tmux-detector.ts`):
- Scans all tmux panes for Claude Code sessions showing rate-limit messages.
- Pattern-matches against `rate limit`, `usage limit`, `quota exceeded`,
  `too many requests`, `hit your limit`, `5-hour`, `weekly`, etc.
- Confidence scoring: Claude indicators (+0.4) + rate-limit match (+0.4) +
  waiting prompt (+0.2) + multiple matches (+0.1).
- Can auto-resume by sending `1` + Enter to select the first menu option.

### Spinner character handling

Much narrower than dmux. `paneHasActiveTask` only recognizes two spinner
characters: `·` (U+00B7 middle dot) and `✻` (U+273B heavy asterisk). The
regex requires 1-4 capitalized words after the spinner, ending in `...` or `…`.

This means it will NOT detect Claude Code's other spinner frames like `✳`,
`✽`, `✶`, or `⚙`, or creative non-capitalized gerunds. However, the
`"esc to interrupt"` check serves as a reliable catch-all -- Claude Code always
shows this text while processing.

### UI chrome stripping

Like dmux, oh-my-claudecode does NOT strip UI chrome. Instead:
- `paneLooksReady` looks for prompt characters (`❯`, `›`, `>`) as positive
  signals of idle state.
- `paneHasActiveTask` looks for `"esc to interrupt"` and spinner patterns as
  positive signals of active state.
- Separator lines (`─`), status bar text (`⏵⏵ accept edits`), and other
  chrome are simply ignored -- they don't match either positive pattern.

### Anti-flicker patterns

1. **NudgeTracker debounce**: pane must be continuously idle for 30s
   (`delayMs`) before the first nudge. If the pane becomes active at any point,
   `firstIdleAt` resets to null.
2. **Scan interval throttle**: `checkAndNudge` skips if the last scan was less
   than 5s ago.
3. **Max nudge cap**: at most 3 nudges per pane per wait call, preventing
   infinite loops.
4. **Tail-focused analysis**: `paneHasActiveTask` only examines the last 40
   lines; `paneLooksReady` examines the last non-blank line. This limits
   sensitivity to buffer history noise.
5. **No LLM dependency**: all detection is regex-based, so state transitions
   are instantaneous with no async jitter from API calls.

---

## Comparison Summary

| Aspect | dmux | oh-my-claudecode |
|---|---|---|
| Stars | 1,323 | 21,613 |
| Detection approach | Heuristic + LLM fallback | Pure heuristic |
| Capture flags | `-p -J -S -50` (join wraps) | `-p -S -80` (raw) |
| Spinner chars recognized | ~30+ (braille, geometric, asterisks, hourglasses) | 2 (`·`, `✻`) |
| `"esc to interrupt"` check | Yes (primary signal) | Yes (primary signal) |
| Prompt detection | `> $ ❯ ›` with `│`-prefix variants | `> ❯ ›` |
| User-typing detection | Yes (prefix-stable prompt edits) | No |
| LLM for ambiguous states | Yes (OpenRouter, 3-model parallel race) | No |
| Anti-flicker | Settle timers + fingerprint + cache + `-J` | Debounce timer + scan throttle |
| Autopilot (auto-accept) | Yes (first option, with risk check) | Yes (nudge message, no risk check) |

### Key takeaway for Spur

Both projects confirm the same core pattern:
1. `"esc to interrupt"` is the single most reliable working-state signal.
2. Prompt characters (`❯`, `›`, `>`) at the end of output are the most
   reliable idle-state signal.
3. Spinner characters are supplementary -- useful but not essential when
   `"esc to interrupt"` is checked.
4. Neither project strips Claude's UI chrome; both use positive-match patterns
   that ignore irrelevant chrome lines.
5. The `-J` flag on `capture-pane` (dmux) is a valuable anti-flicker trick that
   prevents terminal width changes from registering as content changes.
6. Settle/debounce timers (1.5-3.5s in dmux, 30s in omc) prevent rapid state
   oscillation.
