# Research 10: Spur Status Detection — Full Analysis

## Files Analyzed

- `v2/src/session-service.ts` — classifyLivePaneState, classifyCodexTitle, classifyCodexPane, classifyAgentState, normalizePaneLines, isWaitingInput, enrich()
- `v2/src/agent-hook-state.ts` — readAgentHookState, deleteAgentHookState
- `v2/src/session-slots.ts` — spur-agent-state-updater.mjs (inline script), mapHookEventToState
- `v2/src/agents/claude.ts` — hook registration (SessionStart, UserPromptSubmit, Stop)
- `v2/src/runtime-tmux.ts` — captureTmuxPane, getTmuxPaneTitle
- `v2/test/fast/session-service.test.ts` — all status-related tests

---

## 1. Claude Agent — Every Code Path That Determines SessionState

### Entry point: `enrich()` (line 2003)

```
enrich(session) →
  1. status === "killed"         → state = "killed"
  2. status === "paused"|"completed" → state = "stopped"
  3. status === "errored"        → state = "error"
  4. status === "spawning"       → state = "working"
  5. !runtimeAlive || !processAlive → state = "stopped"
  6. ELSE (running + alive):
     a. hookState.state === "working" AND fresh (<=2s) → state = "working"  [NO pane check]
     b. hookState.state === "waiting"                  → pane check for needs_input only;
        if pane says needs_input → "needs_input", else → "waiting"
     c. No hook state / stale working hook              → full pane classification via classifyAgentState()
```

### classifyAgentState for Claude (line 283)

For `agent !== "codex"`, goes straight to:
```
classifyLivePaneState(pane)
```

### classifyLivePaneState (line 245)

```
1. normalizePaneLines(pane)    — strip blank lines, strip TRAILING_UI_RE from bottom
2. isWaitingInput(lines)       — check PERMISSION_PROMPTS and interview patterns
   → if true: "needs_input"
3. PROMPT_RE test on last line  — /^[❯›>$#](?:\s.*)?$/
   → if matches: "waiting"
   → else: "working"
```

### normalizePaneLines (line 208)

Strips trailing lines matching TRAILING_UI_RE:
- `/^[─━]+$/` — horizontal rules
- `/^⏵⏵ /` — some UI prefix
- `/^Claude in Chrome enabled\b/`
- `/^Update available!\b/`
- `/^gpt-[\w.-]+\b.*·/` — Codex model line

### isWaitingInput (line 193)

Takes last 12 lines, joins with space, checks:
1. PERMISSION_PROMPTS (any match → true):
   - `/approval required/i`
   - `/Do you want to proceed\?/i`
   - `/\((?:y|Y)\)es.*\((?:n|N)\)o/i`
   - `/Would you like to (?:run|grant|make|approve)\b/i`
2. Interview pattern (ALL must match):
   - `INTERVIEW_ENTER_RE`: `/\bEnter to select\b/i`
   - `INTERVIEW_ESCAPE_RE`: `/\bEsc to cancel\b/i`
   - At least 2 lines matching `INTERVIEW_OPTION_RE`: `/^\d+[.:]\s/`

### State debounce (line 2043)

After classification, if the new state differs from the cached state and the cache is less than STATE_HOLD_MS (4s) old, the new state is suppressed UNLESS it is `needs_input`, `stopped`, `killed`, or `error`.

### Hook state flow for Claude

Hooks registered: SessionStart, UserPromptSubmit, Stop.
- `UserPromptSubmit` → writes `{ state: "working", updatedAt: now }` — means user submitted a prompt, agent is working
- `SessionStart` → writes `{ state: "waiting" }` — agent just started, waiting for input
- `Stop` → writes `{ state: "waiting" }` — agent finished a turn, waiting for input

Hook freshness threshold: HOOK_FRESHNESS_MS = 2000ms. Only the "working" state from hooks uses freshness; "waiting" is trusted indefinitely.

---

## 2. Codex Agent — Every Code Path That Determines SessionState

### classifyAgentState for Codex (line 283)

```
1. getTmuxPaneTitle(tmuxSession) → classifyCodexTitle(title)
   If title gives a definitive answer (non-null), return it immediately.
2. If title returns null → captureTmuxPane → classifyCodexPane(pane)
```

### classifyCodexTitle (line 257)

```
1. /\bReady\b/i         → "waiting"
2. /\b(?:Thinking|Working|Starting|Undoing|Exploring)\b/i → "working"
3. /\bWaiting\b/i       → "needs_input"
4. CODEX_BRAILLE_SPINNER_RE but no status word → null (fall through to pane)
5. No spinner + non-empty title → "waiting" (idle)
6. Empty title → null (fall through to pane)
```

CODEX_BRAILLE_SPINNER_RE: `/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/` — 10 Braille characters used in Codex spinner.

### classifyCodexPane (line 274)

```
1. normalizePaneLines(pane) → isWaitingInput(lines) → "needs_input"
2. CODEX_QUESTION_RE on tail: /\benter to submit\b/i → "needs_input"
3. CODEX_PANE_WORKING_RE on full pane: /esc to interrupt/i → "working"
4. else → "waiting"
```

Note: Codex classification checks "esc to interrupt" on the FULL pane (not just tail), because Codex shows it in the working status line. The question UI also shows "esc to interrupt" but is caught earlier by CODEX_QUESTION_RE.

---

## 3. All Failure Modes

### F1: Claude "always waiting" — the core bug

**The problem:** Claude Code ALWAYS renders a `❯` input prompt at the bottom of the pane, even while actively working. The TUI layout is:

```
[streaming output from agent]
[... more output ...]

❯
```

The `❯` is always present. It is the input field, visible at all times. When Claude is working (streaming a response, running tools), the `❯` is still there at the bottom.

**What happens:** `classifyLivePaneState` calls `normalizePaneLines`, strips TRAILING_UI_RE lines from the bottom, then checks if the last remaining line matches `PROMPT_RE = /^[❯›>$#](?:\s.*)?$/`. Since `❯` is always the last non-UI-chrome line, PROMPT_RE always matches, so the function always returns `"waiting"`.

**When hooks save it:** If the `UserPromptSubmit` hook fired within the last 2s, the hook state overrides pane classification and returns `"working"`. But after 2s, it falls through to pane classification, which incorrectly says "waiting".

**When hooks DON'T save it:** A typical Claude Code task runs 30s-5min. The hook is fresh for 2s. For the remaining 28s-4m58s, the state is wrong.

**Impact:** `spur list` shows Claude sessions as "waiting" (idle) when they are actively working. This is the most common misclassification.

### F2: Claude working state has no pane-level signal

Unlike Codex (which shows "esc to interrupt" and has title-based status), Claude Code provides no reliable pane-level indicator of working state. There is no spinner character in the pane, no "thinking" status line, no "esc to interrupt" equivalent.

Claude Code's visual working indicator is a spinner/animation in the TUI, but it is rendered using cursor movement and ANSI escape sequences that `tmux capture-pane -p` does not preserve. The captured pane just shows static text plus `❯`.

### F3: Hook freshness window too short

HOOK_FRESHNESS_MS = 2000ms. Claude Code tasks typically take 10s-5min per turn. The "working" hook is only trusted for 2s, then the system falls through to pane classification which (per F1) always returns "waiting".

The freshness window exists to prevent stale "working" state from persisting after the agent finishes, but 2s is far too aggressive.

### F4: No "Stop" hook freshness check

When `hookState.state === "waiting"` (from Stop or SessionStart hook), it is trusted indefinitely — there is no staleness check. This is intentional to avoid flicker (the Stop hook fires at the end of a turn, and the agent stays waiting until the next UserPromptSubmit). But it means if the agent crashes after the Stop hook fires, the state stays "waiting" rather than "stopped" until the process-alive check kicks in.

### F5: Codex title not always available

Codex sets the terminal title via escape sequences. Some tmux configurations or terminal multiplexer chains may not propagate these. If `getTmuxPaneTitle` returns empty, the system falls back to pane content, which is less reliable.

### F6: normalizePaneLines strips too aggressively or not enough

The TRAILING_UI_RE list is hardcoded. If Claude Code or Codex adds new UI chrome at the bottom, it won't be stripped, potentially masking the prompt character. Conversely, if content that looks like UI chrome appears in normal output, it could be incorrectly stripped.

### F7: PROMPT_RE too broad

`/^[❯›>$#](?:\s.*)?$/` matches shell prompts (`$`, `#`, `>`), which means if the agent exits and drops to a shell, the state is "waiting" rather than "stopped". The process-alive check should catch this, but there is a race window.

### F8: Debounce masks real transitions

The 4s debounce window suppresses `working → waiting` and `waiting → working` transitions. This is a trade-off: it reduces flicker but delays real state changes by up to 4s. Combined with F1, if the system briefly classifies "working" (from a fresh hook) then falls to "waiting" (from pane), the debounce holds "working" for 4s — but then drops to the incorrect "waiting" anyway.

### F9: "esc to interrupt" false positive risk for Codex

`CODEX_PANE_WORKING_RE = /esc to interrupt/i` matches anywhere in the full pane. If "esc to interrupt" appears in agent output (e.g., instructions the agent writes), it would falsely classify as "working". The question UI check (CODEX_QUESTION_RE) runs first to catch the known ambiguous case.

### F10: Hook state file race conditions

The hook state is written atomically (rename) but read without locking. If `readAgentHookState` reads between the write and the rename, it could get stale data. In practice this is unlikely due to atomic rename, but the read uses `existsSync` + `readFileSync` which is a TOCTOU race if the file is deleted between the two calls.

---

## 4. The Exact Problem: Claude `❯` Always Present

Claude Code's TUI renders three zones:
1. **Output area** — streaming text, tool results, thinking
2. **Status bar** — horizontal rules, "Claude in Chrome enabled", etc.
3. **Input area** — always shows `❯` prompt character

When `tmux capture-pane -p` captures the pane:
- The output area contains the agent's response text
- The status bar lines are stripped by TRAILING_UI_RE
- The input `❯` remains as the last non-blank line

PROMPT_RE matches `❯` → returns "waiting" regardless of whether the agent is actively working.

**The fundamental issue:** `classifyLivePaneState` assumes that seeing a prompt character means the agent is idle. This assumption is correct for shell prompts but incorrect for Claude Code's persistent input field.

---

## 5. What the Fix Should Be

### Option A: Extend hook trust window (simplest)

Instead of HOOK_FRESHNESS_MS = 2000ms, use a much longer window (e.g., 5-10 minutes) or remove the freshness check entirely for Claude. Trust "working" from hooks until a "waiting" (Stop) hook overwrites it.

**Pros:** Minimal code change, hooks are the most reliable signal.
**Cons:** If hooks fail to fire (crash, misconfiguration), the state stays stuck as "working" for the full trust window.

### Option B: Hook-primary with pane fallback

Make hooks the primary state source for Claude. Only fall through to pane classification when there is NO hook state at all (first poll before any hook fires). When hook state exists, trust it indefinitely until a new hook event overwrites it.

The pane check would only be used for:
1. `needs_input` detection (permission prompts, interview UIs) — these always override
2. First poll before any hook has fired

**Pros:** Accurate for the common case. Pane still catches needs_input.
**Cons:** Requires hooks to be properly installed. If Stop hook doesn't fire, "working" persists.

### Option C: Claude-specific pane heuristic

Detect Claude Code's working state from pane content by looking for:
- Lines that contain tool execution output (file edits, bash commands)
- Streaming text that changes between polls (would require caching previous capture)
- Specific Claude Code UI elements that appear only during work

**Pros:** No hook dependency.
**Cons:** Fragile, relies on Claude Code's specific output format.

### Option D: Claude Code title-based detection (like Codex)

Claude Code does not currently set terminal title with status. But if it did (or if Spur could configure it to), the same approach as Codex could be used.

**Pros:** Clean signal.
**Cons:** Requires Claude Code to support this feature.

### Recommended: Option B

Hook-primary for Claude, with pane fallback only for needs_input and initial state. The hooks (SessionStart, UserPromptSubmit, Stop) already provide a complete lifecycle signal. The current code already trusts "waiting" hooks indefinitely — it should also trust "working" hooks indefinitely (until a "waiting" hook overwrites them).

The fix in `enrich()`:
```
// Current (broken for Claude):
if (hookState?.state === "working" && fresh(hookState)) → "working"
else if (hookState?.state === "waiting") → check pane for needs_input, else "waiting"
else → full pane classification (always returns "waiting" for Claude)

// Fixed:
if (hookState?.state === "working") → check pane for needs_input, else "working"
if (hookState?.state === "waiting") → check pane for needs_input, else "waiting"
else → full pane classification (fallback for no-hook case)
```

The freshness check on "working" should be removed. Both "working" and "waiting" hooks are trusted until the next hook event overwrites them, with pane checks only for needs_input overlay.

---

## 6. All Spinner/Status Characters Found in Code and Tests

### Codex Braille spinner characters (terminal title)
Used in `CODEX_BRAILLE_SPINNER_RE`: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`

### Spur CLI spinner frames (cli-view.ts)
`SPINNER_FRAMES = ["𖤓  ", " 𖤓 ", "  𖤓", " 𖤓 "]` — uses the Spur brand mark `𖤓`

### Claude Code prompt character
`❯` — always visible in Claude Code's input area, matched by PROMPT_RE

### Codex prompt character
`›` — always visible in Codex's input area, matched by PROMPT_RE

### Other prompt characters matched by PROMPT_RE
`>`, `$`, `#` — shell prompts

### Codex title status words
`Ready`, `Thinking`, `Working`, `Starting`, `Undoing`, `Exploring`, `Waiting`

### No Claude Code spinner characters exist in the codebase
There is no `CLAUDE_SPINNER_RE` or equivalent. Claude Code does not expose spinner state through tmux-capturable content.
