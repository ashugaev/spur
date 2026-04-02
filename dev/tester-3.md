# Tester 3: Live Session Verification

## Methodology

Captured real data from 10 live sessions (5 Claude, 5 Codex) using:
- `tmux capture-pane` for pane content
- `tmux display-message` for terminal title
- Hook state files from `~/.spur/session-agent-state/`
- Simulated both current and proposed classification logic

## Live Session Data Summary

| Session | Agent | Hook State | Hook Age | Pane Signal | Current State | Proposed State | Delta |
|---------|-------|-----------|----------|-------------|---------------|----------------|-------|
| intelas-1923 | claude | working (UserPromptSubmit) | ~9m | needs_input (permission prompt) | needs_input | needs_input | SAME |
| intelas-b0e5 | claude | working (UserPromptSubmit) | ~13m | no esc-to-interrupt, has `❯` | working | working | SAME |
| intelas-25f5 | claude | working (UserPromptSubmit) | ~3m | no esc-to-interrupt, has `❯` | waiting | **working** | **FIX** |
| intelas-8888 | claude | waiting (Stop) | ~8m | has `❯`, no esc-to-interrupt | waiting | waiting | SAME |
| spur-85d8 | claude | waiting (Stop) | ~1m | has esc-to-interrupt(2x), has `❯` | waiting | waiting | SAME |
| spur-97db | codex | waiting (Stop) | ~23m | idle prompt `›` | waiting | waiting | SAME |
| spur-73d4 | codex | working (UserPromptSubmit) | ~31m | API error, process alive but stuck | waiting | **working** | **CONCERN** |
| spur-7e37 | codex | waiting (Stop) | ~4h | idle prompt `›` | waiting | waiting | SAME |
| spur-f434 | codex | waiting (Stop) | ~4h | idle prompt `›` | waiting | waiting | SAME |
| spur-92ad | codex | (none) | N/A | exited to zsh shell | stopped | stopped* | SAME |

*spur-92ad: processAlive=false catches this before hook/pane logic runs.

## Key Findings

### 1. intelas-25f5: THE BUG CASE (PASS)

This session demonstrates the exact bug the architect plan targets.

- **Hook state:** `working` (UserPromptSubmit fired ~3 minutes ago)
- **Pane content:** Claude is actively running tool calls (Bash commands, file reads). The TUI shows `✽ Improvising...` and active tool execution with `+18 more tool uses`.
- **Current behavior:** Hook freshness expired after 2s. Falls through to `classifyLivePaneState()`. Sees `❯` on the last line. Returns `"waiting"`. **WRONG.**
- **Proposed behavior:** Trusts hook `"working"` state. Returns `"working"`. **CORRECT.**
- **Title:** `⠐ Implement feature for WEBDEV-4611` (Claude's brand mark, confirms active session)

This is the canonical case: a multi-minute Claude turn with tool calls. The hook correctly records "working" from UserPromptSubmit, but the 2s freshness window discards it.

### 2. intelas-1923: needs_input OVERLAY (PASS)

- **Hook state:** `working` (UserPromptSubmit fired ~9 minutes ago)
- **Pane content:** Permission prompt visible: "Do you want to proceed? / 1. Yes / 2. Yes, and always allow..."
- **Current behavior:** Hook freshness expired. Falls to pane. Detects PERMISSION_PROMPTS. Returns `"needs_input"`. **Correct by accident.**
- **Proposed behavior:** Trusts hook "working" but overlays pane check for needs_input. Detects permission prompt. Returns `"needs_input"`. **Correct by design.**

This validates the architect's decision to always check pane for needs_input even when hook says "working".

### 3. intelas-b0e5: STALE WORKING HOOK, ACTUALLY IDLE (NEUTRAL)

- **Hook state:** `working` (UserPromptSubmit fired ~13 minutes ago)
- **Pane content:** Shows a completed analysis with `❯` prompt and user-typed text at bottom. Claude appears to be in plan mode (`⏸ plan mode on`). No active tool execution visible.
- **Current behavior:** Hook freshness expired. Falls to pane. Pane classifier returns "working" (because the pane structure doesn't match simple `❯`-on-last-line; there's text after the prompt). **Actually wrong -- should be "waiting".**
- **Proposed behavior:** Trusts hook "working". Returns "working". **Also wrong -- should be "waiting".**

Both current and proposed get this wrong. The hook says "working" from a UserPromptSubmit that was 13 minutes ago. The user typed text at the prompt but Claude is in "plan mode" waiting for the user to press Enter or give more input. Neither system detects this as "waiting".

However, this is a pre-existing issue unrelated to the proposed change. The Stop hook should have fired when Claude entered plan mode waiting state. If it did not fire, that is a hook coverage gap, not a classification logic issue.

### 4. spur-73d4: STALE WORKING HOOK, CODEX ERRORED (CONCERN)

- **Hook state:** `working` (UserPromptSubmit fired ~31 minutes ago)
- **Pane content:** Codex hit an API error (`invalid_request_error`) and is showing an error block. The codex process (pid 27694) IS still alive on the TTY, along with MCP subprocesses.
- **Current behavior:** Hook freshness expired. Falls to Codex title classifier. Title is just "spur-73d4" (no Braille spinner, no status keyword). Returns "waiting". **Somewhat correct -- Codex is stuck, not actively working.**
- **Proposed behavior:** Trusts hook "working". Returns "working". **Wrong -- Codex is stuck on an API error, not actively working.**

This is a genuine concern with the proposed approach. The codex process is alive (so processAlive=true) but it hit an unrecoverable API error. The Stop hook never fired because codex did not cleanly finish its turn. The hook file is stuck at "working" indefinitely.

**Severity:** Medium. This is a rare edge case (API error that leaves process alive but non-functional). The user would see "working" instead of realizing the session is stuck. However:
- The Codex title classifier would catch this if title-based detection ran (title has no spinner = idle)
- The proposed plan does not change Codex classification -- Codex still uses title + pane, not just hooks
- Wait: re-reading the proposed plan, step 2 in the waterfall checks hook state BEFORE step 3 (title). So for Codex, the hook "working" would be trusted and title check would NOT run.

**This is a real regression for Codex.** The current code's title classifier correctly identifies this as "waiting" (no spinner in title). The proposed code would trust the stale hook and return "working".

### 5. intelas-8888: TARGET SESSION (PASS)

- **Hook state:** `waiting` (Stop fired ~8 minutes ago)
- **Pane content:** Claude finished work. PR #3432 merged. Shows `✻ Churned for 13m 39s` and idle `❯` prompt.
- **Current behavior:** Hook says "waiting". Pane check confirms no needs_input. Returns "waiting". **Correct.**
- **Proposed behavior:** Same path, same result. **Correct.**
- **Title:** `✳ Continue WEBDEV-6430 pull request`

intelas-8888 is correctly classified by both current and proposed logic. It is genuinely idle/waiting. The session that triggered this investigation is not itself misclassified -- the issue was observed in OTHER sessions during the investigation.

### 6. spur-85d8: "esc to interrupt" PRESENT (INFORMATIVE)

- **Hook state:** `waiting` (Stop fired)
- **Pane content:** Contains "esc to interrupt" text (2 occurrences) but these are from the user's typed message content, not from active agent execution.
- **Current behavior:** "waiting" (hook says waiting, pane needs_input check negative).
- **Proposed behavior:** "waiting" (same path).

Note: the "esc to interrupt" text appears in the pane but it is in the user's typed prompt content, not in Claude's TUI chrome. This does NOT cause a false positive because when hook state is present, the pane is only checked for needs_input, not for working indicators. The "esc to interrupt" check only runs in the no-hook fallback path. This validates the architect's design.

## Assessment of Proposed Changes

### Confirmed Fixes

1. **intelas-25f5 bug:** The core fix (trusting hook state without freshness) correctly reclassifies this from "waiting" to "working". This is the primary objective and it works.

2. **needs_input overlay:** intelas-1923 confirms that checking pane for needs_input even when hook says "working" is correct and necessary.

3. **"esc to interrupt" in fallback path:** Not triggered in current live sessions (all have hook state), but the signal is present in spur-85d8's pane content. Importantly, it does NOT cause false positives when hook state exists because the fallback path only runs when there is no hook state.

### Concern: Codex with Stale Working Hook (spur-73d4)

The proposed waterfall checks hook state BEFORE agent-specific classifiers (title, pane). For Codex, the existing title classifier is more accurate than the hook when codex hits an API error and the process stays alive.

**Recommendation:** For Codex, the waterfall should check title BEFORE trusting the hook, or at minimum, when hook says "working", verify against the Codex title classifier as an additional signal (similar to how it checks pane for needs_input on Claude). The title spinner is a cheap, reliable heartbeat for Codex.

Alternatively, the architect could add a special case: when hook state is "working" AND agent is "codex", check the title for the Braille spinner. If the spinner is absent, override to "waiting".

### Neutral: intelas-b0e5 (pre-existing issue)

Both current and proposed misclassify this session. The UserPromptSubmit hook fired 13 minutes ago but the agent appears idle in "plan mode". This suggests that Claude's plan mode does not fire the Stop hook. This is a hook coverage gap that exists regardless of the proposed change. Adding PreToolUse/PostToolUse hooks (as proposed) would help diagnose this -- if no tool hooks fire for minutes while the hook says "working", it is a signal the agent may be idle.

## Codex Behavior Check

For the 4 Codex sessions with hook state (spur-97db, spur-73d4, spur-7e37, spur-f434):
- The `-J` flag on capture-pane would not change classification for any of them (all are in terminal idle states with clear prompt lines)
- The "esc to interrupt" check would not fire because Codex pane classification uses a separate code path (`classifyCodexPane`) which already has its own `CODEX_PANE_WORKING_RE` for "esc to interrupt"
- The concern is only about hook-first vs title-first ordering for Codex

## Verdict

**PASS with one recommendation.**

The core fix (removing HOOK_FRESHNESS_MS, trusting hooks) is validated by live data. It correctly fixes the intelas-25f5 bug and does not regress the 7 other well-behaved sessions.

One edge case needs attention: **spur-73d4 demonstrates that Codex can have a stale "working" hook when the process is alive but stuck on an API error.** The proposed waterfall should either:
1. Check Codex title classifier as a "working" confirmation when hook says "working" (preferred -- cheap and reliable), or
2. Document this as a known limitation with the mitigation that PreToolUse/PostToolUse hooks will provide a freshness heartbeat that can be checked in a future enhancement.

Option 1 is a small addition to step 2 of the waterfall: when hook says "working" and agent is "codex", also check the title for the Braille spinner. If absent, fall through to full Codex classification.
